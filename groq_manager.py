import os
import logging
import time
from groq import Groq, RateLimitError

class GroqManager:
    def __init__(self):
        # Load keys from environment variable (comma-separated)
        raw_keys = os.environ.get("GROQ_API_KEY", "")
        self.keys = [k.strip() for k in raw_keys.split(",") if k.strip()]
        
        if not self.keys:
            logging.warning("No GROQ_API_KEY found in environment variables.")
            self.keys = [""]  # Fallback to empty to avoid indexing errors
            
        self.current_idx = 0
        self._clients = {}  # Cache clients per key

    def get_client(self):
        """Returns a Groq client for the current active key."""
        key = self.keys[self.current_idx]
        if key not in self._clients:
            self._clients[key] = Groq(api_key=key, timeout=1200.0)
        return self._clients[key]

    def rotate(self):
        """Moves to the next key in the list."""
        if len(self.keys) <= 1:
            logging.info("Only one API key available. Staying on the current key.")
            return False
            
        old_key_masked = f"{self.keys[self.current_idx][:6]}...{self.keys[self.current_idx][-4:]}"
        self.current_idx = (self.current_idx + 1) % len(self.keys)
        new_key_masked = f"{self.keys[self.current_idx][:6]}...{self.keys[self.current_idx][-4:]}"
        
        logging.info(f"API Key Rotated: Switched from {old_key_masked} to {new_key_masked}")
        return True

    def execute_with_retry(self, func, *args, **kwargs):
        """
        Executes a groq call with automatic rotation on RateLimitError.
        'func' should be a callable that takes (client, model) as its first two arguments.
        """
        primary_model = kwargs.pop("model", "llama-3.3-70b-versatile")
        fallback_model = "llama-3.1-8b-instant"
        
        # Try both models if needed
        for current_model in [primary_model, fallback_model]:
            for attempt in range(len(self.keys) * 2):
                client = self.get_client()
                try:
                    # Execute the function with current client and model
                    return func(client, current_model, *args, **kwargs)
                
                except Exception as e:
                    # Catch RateLimitError (429) OR Payload/TPM Error (413)
                    err_str = str(e).lower()
                    is_too_large = "413" in err_str or "too large" in err_str or "tpn" in err_str or "tpm" in err_str
                    is_rate_limit = "429" in err_str or "rate limit" in err_str
                    
                    if is_too_large:
                        if current_model == primary_model:
                            logging.warning(f"Request too large for {primary_model}. Switching to {fallback_model} immediately.")
                            break # Fallback to 88
                        else:
                            logging.error(f"Request too large even for {fallback_model}. Clipping may be required.")
                            raise e

                    if is_rate_limit:
                        logging.warning(f"Rate Limit hit for {current_model} (Attempt {attempt+1}): {e}")
                        # If we have more keys, rotate and try same model
                        if len(self.keys) > 1:
                            self.rotate()
                            time.sleep(0.5)
                            continue
                        else:
                            # Only one key or all keys hit for THIS model.
                            if current_model == primary_model:
                                logging.info(f"Primary model {primary_model} exhausted. Falling back to {fallback_model}...")
                                break 
                            else:
                                # Both models exhausted on all keys
                                wait_time = min(30, (2 ** attempt) + 5)
                                logging.info(f"All models/keys exhausted. Waiting {wait_time}s...")
                                time.sleep(wait_time)
                                continue

                    # For other transient errors (500, 503)
                    logging.error(f"Groq API Error: {e}")
                    if "500" in str(e) or "503" in str(e):
                        if self.rotate(): continue
                    raise e
                    
        raise RuntimeError("Exhausted all API keys and model fallbacks.")
