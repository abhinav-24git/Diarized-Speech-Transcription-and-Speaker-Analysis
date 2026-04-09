$(document).ready(function () {
    // Chart instances storage
    let userCharts = {};
    let mainDoughnut = null;
    let interactionRadar = null;

    // Global state for renaming
    let globalData = {}; // holds the full API response
    let currentNameMap = {}; // current display names: { originalKey -> displayName }

    // Formatting Helpers
    function formatTime(seconds) {
        if (!seconds) return "00:00";
        var date = new Date(0);
        date.setSeconds(seconds);
        return date.toISOString().substring(14, 19);
    }

    const colorPalette = ['#06b6d4', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#3b82f6'];
    let speakerColors = {};
    let colorIndex = 0;

    function getSpeakerColor(speaker) {
        if (!speakerColors[speaker]) {
            speakerColors[speaker] = colorPalette[colorIndex % colorPalette.length];
            colorIndex++;
        }
        return speakerColors[speaker];
    }

    // Theme Toggling Logic
    const themeToggleBtn = $('#themeToggle');
    const themeIcon = $('#themeIcon');

    const savedTheme = localStorage.getItem('theme') || 'dark';
    if (savedTheme === 'light') {
        $('html').attr('data-theme', 'light');
        themeIcon.removeClass('fa-moon').addClass('fa-sun');
    }

    themeToggleBtn.click(function () {
        const currentTheme = $('html').attr('data-theme');
        if (currentTheme === 'light') {
            $('html').removeAttr('data-theme');
            localStorage.setItem('theme', 'dark');
            themeIcon.removeClass('fa-sun').addClass('fa-moon');
        } else {
            $('html').attr('data-theme', 'light');
            localStorage.setItem('theme', 'light');
            themeIcon.removeClass('fa-moon').addClass('fa-sun');
        }
    });

    // Chart Defaults
    Chart.defaults.color = '#64748b';
    Chart.defaults.borderColor = 'rgba(100, 116, 139, 0.2)';

    // -----------------------------------------------
    // SPEAKER IDENTITY PANEL
    // -----------------------------------------------
    function renderSpeakerIdentityPanel(nameMap, segmentSpeakers) {
        // nameMap: { "SPEAKER 1": "Alice" or "SPEAKER 1" (if unknown) }
        const allSpeakers = [...new Set(segmentSpeakers)];

        let panelHTML = `
        <div class="glass-panel p-4 mb-4" id="speakerIdentityPanel">
            <div class="d-flex align-items-center justify-content-between mb-3">
                <h5 class="text-muted-custom fs-6 text-uppercase mb-0">
                    <i class="fa-solid fa-id-badge me-2" style="color: var(--accent-cyan);"></i>Speaker Identity
                </h5>
                <span class="badge text-uppercase" style="font-size:0.65rem; background: rgba(6,182,212,0.15); color: var(--accent-cyan); border: 1px solid rgba(6,182,212,0.3); padding: 4px 10px; border-radius:20px; letter-spacing:1px;">
                    <i class="fa-solid fa-wand-magic-sparkles me-1"></i>AI Detected
                </span>
            </div>
            <p class="text-muted-custom mb-3" style="font-size: 0.82rem;">
                The AI identified speaker names and roles from the conversation. Real names take priority, followed by role detection (Interviewer, Candidate, Manager, etc.). Edit any label below — changes apply instantly across the entire dashboard.
            </p>
            <div class="row g-3" id="speakerIdentityCards">
        `;

        // Role keywords that indicate role-based (not name-based) identification
        const ROLE_KEYWORDS = [
            'interviewer', 'candidate', 'moderator', 'team leader', 'lead',
            'ceo', 'manager', 'director', 'presenter', 'client',
            'expert', 'consultant', 'hr', 'note taker', 'chairman', 'host'
        ];

        allSpeakers.forEach((spk, idx) => {
            // Defensive check for missing name
            const spkLabel = spk || "Unidentified";
            const color = getSpeakerColor(spkLabel);
            const displayName = nameMap[spkLabel] || spkLabel;
            const isUnknown = (displayName === spkLabel && spkLabel.startsWith('SPEAKER'));
            const isRole = !isUnknown && ROLE_KEYWORDS.some(r => displayName.toLowerCase().includes(r));
            const isName = !isUnknown && !isRole;

            let statusBadge;
            if (isName) {
                statusBadge = `<span class="speaker-id-badge identified"><i class="fa-solid fa-user me-1"></i>Name</span>`;
            } else if (isRole) {
                statusBadge = `<span class="speaker-id-badge role-detected"><i class="fa-solid fa-briefcase me-1"></i>Role</span>`;
            } else {
                statusBadge = `<span class="speaker-id-badge unknown">Unidentified</span>`;
            }

            const initial = spkLabel.replace('SPEAKER ', 'S').charAt(0);

            panelHTML += `
                <div class="col-12 col-md-6 col-lg-4">
                    <div class="speaker-id-card" data-speaker="${spkLabel}">
                        <div class="d-flex align-items-center gap-3 mb-3">
                            <div class="avatar-ring flex-shrink-0" style="border-color: ${color}; width:42px; height:42px; font-size:0.9rem;">${initial}</div>
                            <div class="flex-grow-1 min-w-0">
                                <div class="text-muted-custom" style="font-size:0.7rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px;">${spkLabel}</div>
                                <div class="fw-semibold text-main speaker-display-name" style="font-size:0.95rem; color:${color};">${displayName}</div>
                            </div>
                            ${statusBadge}
                        </div>
                        <div class="d-flex gap-2">
                            <input 
                                type="text" 
                                class="form-control modern-input speaker-rename-input" 
                                placeholder="Enter name..." 
                                value="${isUnknown ? '' : displayName}"
                                data-original-speaker="${spkLabel}"
                                style="font-size:0.85rem; padding: 6px 12px;"
                                id="rename-input-${idx}"
                            >
                            <button 
                                class="btn glow-btn speaker-rename-btn" 
                                data-original-speaker="${spkLabel}"
                                data-input-id="rename-input-${idx}"
                                style="padding: 6px 14px; font-size:0.82rem; white-space:nowrap;"
                                title="Apply name change"
                            >
                                <i class="fa-solid fa-check me-1"></i>Apply
                            </button>
                        </div>
                    </div>
                </div>
            `;
        });

        panelHTML += `</div></div>`;
        return panelHTML;
    }

    // -----------------------------------------------
    // APPLY RENAME ACROSS ALL UI
    // -----------------------------------------------
    function applyRename(originalSpeaker, newName) {
        if (!newName || !newName.trim()) return;
        newName = newName.trim();

        const oldDisplayName = currentNameMap[originalSpeaker] || originalSpeaker;

        // Update name map
        currentNameMap[originalSpeaker] = newName;

        // Update speaker colors mapping
        if (!speakerColors[newName] && speakerColors[oldDisplayName]) {
            speakerColors[newName] = speakerColors[oldDisplayName];
        }

        // 1. Update Identity Panel display
        const card = $(`.speaker-id-card[data-speaker="${originalSpeaker}"]`);
        card.find('.speaker-display-name').text(newName).css('color', getSpeakerColor(newName));
        card.find('.speaker-id-badge').removeClass('unknown').addClass('identified')
            .html('<i class="fa-solid fa-check me-1"></i>Identified');

        // 2. Update Transcript segments
        const segments = globalData.segments || [];
        let transcriptHTML = "";
        segments.forEach(seg => {
            // Map segment speaker to current display name
            let displaySpk = currentNameMap[seg._original_speaker || seg.speaker] || seg.speaker;
            let initial = displaySpk.charAt(0).toUpperCase();
            let color = getSpeakerColor(displaySpk);
            let timeStr = formatTime(seg.start);

            let textLower = seg.text.toLowerCase();
            let sentColor = '#f59e0b';
            if (textLower.includes('good') || textLower.includes('great') || textLower.includes('agree')) sentColor = '#10b981';
            if (textLower.includes('bad') || textLower.includes('no') || textLower.includes('issue')) sentColor = '#f43f5e';

            transcriptHTML += `
                <div class="chat-bubble">
                    <div class="avatar-ring" style="border-color: ${color};">${initial}</div>
                    <div>
                        <div class="d-flex align-items-center">
                            <span class="sentiment-spark" style="background-color: ${sentColor};"></span>
                            <span style="color: ${color}; font-size: 0.85rem; font-weight: 600;">${displaySpk}</span>
                            <span class="timestamp-dim">${timeStr}</span>
                        </div>
                        <div class="chat-text">${seg.text}</div>
                    </div>
                </div>
            `;
        });
        $('#transcriptContent').html(transcriptHTML);

        // 3. Re-render leaderboard & charts with updated names
        reRenderChartsAndLeaderboard();
    }

    // -----------------------------------------------
    // RE-RENDER CHARTS & LEADERBOARD with currentNameMap
    // -----------------------------------------------
    function reRenderChartsAndLeaderboard() {
        const final_scores = globalData.final_scores || { ranking: [], scores: {} };
        const metrics = globalData.metrics || {};

        // Resolve display name: look up by original key stored in ranking
        const shareLabels = [];
        const shareData = [];
        const bgColors = [];

        final_scores.ranking.forEach(r => {
            const displayName = currentNameMap[r._original_speaker || r.speaker] || r.speaker;
            const spkMet = metrics[r._original_speaker || r.speaker] || {};
            const color = getSpeakerColor(displayName);

            shareLabels.push(displayName);
            shareData.push(spkMet.speaking_share_percent || 0);
            bgColors.push(color);
        });

        // Update doughnut chart
        if (mainDoughnut) {
            mainDoughnut.data.labels = shareLabels;
            mainDoughnut.data.datasets[0].data = shareData;
            mainDoughnut.data.datasets[0].backgroundColor = bgColors;
            mainDoughnut.update();
        }

        // Update leaderboard
        let leaderHTML = "";
        final_scores.ranking.forEach(r => {
            const displayName = currentNameMap[r._original_speaker || r.speaker] || r.speaker;
            const color = getSpeakerColor(displayName);
            leaderHTML += `
                <div>
                    <div class="d-flex justify-content-between mb-1">
                        <span class="text-main" style="font-size: 0.85rem;"><i class="fa-solid fa-trophy me-2 text-muted-custom"></i>${displayName}</span>
                        <span style="font-size: 0.85rem; color: ${color}; font-weight: bold;">${r.score}%</span>
                    </div>
                    <div class="progress progress-dark" style="height: 6px;">
                        <div class="progress-bar" style="width: ${r.score}%; background-color: ${color};"></div>
                    </div>
                </div>
            `;
        });
        $('#leaderboardContainer').html(leaderHTML);

        // Update accordion speaker titles & avatar initials
        final_scores.ranking.forEach((r, idx) => {
            const displayName = currentNameMap[r._original_speaker || r.speaker] || r.speaker;
            const color = getSpeakerColor(displayName);
            $(`#spk-${idx}`).prev('.speaker-accordion-btn').find('span[data-role="spk-name"]').text(displayName);
            $(`#spk-${idx}`).prev('.speaker-accordion-btn').find('.avatar-ring').css('border-color', color).text(displayName.charAt(0).toUpperCase());
        });

        // Update radar chart labels
        if (interactionRadar) {
            interactionRadar.data.labels = shareLabels;
            interactionRadar.update();
        }
    }

    // -----------------------------------------------
    // FORM SUBMIT & RENDER
    // -----------------------------------------------
    $('#uploadForm').submit(function (e) {
        e.preventDefault();
        var formData = new FormData(this);

        $('#uploadSectionContainer').hide();
        $('#loadingSection').fadeIn();
        $('#resultSection').hide();

        $.ajax({
            url: $(this).attr('action'),
            type: 'POST',
            data: formData,
            contentType: false,
            processData: false,
            success: function (data) {
                $('#loadingSection').hide();
                $('#resultSection').fadeIn();

                // Clear old charts
                if (mainDoughnut) mainDoughnut.destroy();
                if (interactionRadar) interactionRadar.destroy();
                for (let k in userCharts) userCharts[k].destroy();
                userCharts = {};
                speakerColors = {};
                colorIndex = 0;
                currentNameMap = {};

                // Store full API response globally
                globalData = data;

                let analysis = data.analysis || {};
                let metrics = data.metrics || {};
                let final_scores = data.final_scores || { ranking: [], scores: {} };
                let explanations = data.explanations || {};
                let nameMap = data.speaker_name_map || {};

                // Build currentNameMap from API names (which are already remapped)
                // The segments' speaker field is already the display name after backend remapping
                // We need to track original -> display for renaming purposes
                // Construct: store original speaker label on each segment & ranking entry
                // Since backend already renamed, we track: displayName -> displayName (user can further rename)
                const allDisplaySpeakers = [...new Set((data.segments || []).map(s => s.speaker))];
                allDisplaySpeakers.forEach(sp => {
                    currentNameMap[sp] = sp; // identity initially; key=displayName, value=displayName
                    // Mark original on each segment
                });
                // Store original speaker ref on segments for re-render tracking
                (data.segments || []).forEach(seg => {
                    seg._original_speaker = seg.speaker; // original display name from backend
                });
                // Store original on ranking
                (final_scores.ranking || []).forEach(r => {
                    r._original_speaker = r.speaker;
                });

                // Set Dashboard Title
                let userTopic = $('#meetingTopicInput').val();
                $('#dashboardTopicTitle').text(userTopic ? userTopic : "Meeting Scope");

                // 1. Executive Summary & Action Items
                $('#topSummary').text(analysis.summary || "No summary available");
                $('#topIntent').text(analysis.intent || "Not identified");

                let impact = analysis.decision_impact || "Low";
                $('#topImpact').text(impact);
                let impactPct = impact.toLowerCase().includes("high") ? 90 : (impact.toLowerCase().includes("medium") ? 50 : 20);
                $('#impactProgressBar').css('width', impactPct + '%');

                let actionsRaw = analysis.action_items || "None";
                let actionList = [];
                if (Array.isArray(actionsRaw)) {
                    actionList = actionsRaw;
                } else if (typeof actionsRaw === 'string') {
                    actionList = actionsRaw.split(/[,.\n]/);
                }
                
                let filteredList = actionList.map(a => a.toString().replace(/^[*-]\s*/, '').trim())
                                           .filter(i => i.length > 3)
                                           .slice(0, 2);
                
                let actionHTML = filteredList.length > 0 
                    ? filteredList.map(a => `<div><i class="fa-solid fa-check text-muted-custom me-1"></i>${a}</div>`).join('') 
                    : "No explicit actions";
                $('#topActions').html(actionHTML);

                // 2. Speaker Identity Panel (inject above transcript)
                const segmentSpeakers = (data.segments || []).map(s => s.speaker);
                const identityPanelHTML = renderSpeakerIdentityPanel(nameMap, segmentSpeakers);
                // Inject before the main split row
                if ($('#speakerIdentityPanel').length === 0) {
                    $(identityPanelHTML).insertBefore($('#resultSection .row.g-4:last'));
                }

                // 3. Transcript
                let transcriptHTML = "";
                if (data.segments && data.segments.length > 0) {
                    data.segments.forEach(seg => {
                        let spk = seg.speaker || "Unidentified";
                        let initial = spk.toString().charAt(0).toUpperCase();
                        let color = getSpeakerColor(spk);
                        let timeStr = formatTime(seg.start);

                        let textLower = (seg.text || "").toLowerCase();
                        let sentColor = '#f59e0b';
                        if (textLower.includes('good') || textLower.includes('great') || textLower.includes('agree')) sentColor = '#10b981';
                        if (textLower.includes('bad') || textLower.includes('no') || textLower.includes('issue')) sentColor = '#f43f5e';

                        transcriptHTML += `
                            <div class="chat-bubble">
                                <div class="avatar-ring" style="border-color: ${color};">${initial}</div>
                                <div>
                                    <div class="d-flex align-items-center">
                                        <span class="sentiment-spark" style="background-color: ${sentColor};"></span>
                                        <span style="color: ${color}; font-size: 0.85rem; font-weight: 600;">${spk}</span>
                                        <span class="timestamp-dim">${timeStr}</span>
                                    </div>
                                    <div class="chat-text">${seg.text || ""}</div>
                                </div>
                            </div>
                        `;
                    });
                }
                $('#transcriptContent').html(transcriptHTML);

                // 4. Doughnut & Leaderboard
                let shareLabels = [];
                let shareData = [];
                let bgColors = [];

                final_scores.ranking.forEach((r, idx) => {
                    let spk = r.speaker;
                    let spkMet = metrics[spk] || {};
                    let color = getSpeakerColor(spk);

                    shareLabels.push(spk);
                    shareData.push(spkMet.speaking_share_percent || 0);
                    bgColors.push(color);
                });

                mainDoughnut = new Chart(document.getElementById('speakingShareChart').getContext('2d'), {
                    type: 'doughnut',
                    data: {
                        labels: shareLabels,
                        datasets: [{ data: shareData, backgroundColor: bgColors, borderWidth: 0 }]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false, cutout: '80%', plugins: { legend: { display: false } }
                    }
                });

                let leaderHTML = "";
                final_scores.ranking.forEach((r, idx) => {
                    let color = getSpeakerColor(r.speaker);
                    leaderHTML += `
                        <div>
                            <div class="d-flex justify-content-between mb-1">
                                <span class="text-main" style="font-size: 0.85rem;"><i class="fa-solid fa-trophy me-2 text-muted-custom"></i>${r.speaker}</span>
                                <span style="font-size: 0.85rem; color: ${color}; font-weight: bold;">${r.score}%</span>
                            </div>
                            <div class="progress progress-dark" style="height: 6px;">
                                <div class="progress-bar" style="width: ${r.score}%; background-color: ${color};"></div>
                            </div>
                        </div>
                    `;
                });
                $('#leaderboardContainer').html(leaderHTML);

                // 5. Speaker Accordions
                let accHTML = "";
                let radarInitData = [];

                final_scores.ranking.forEach((r, idx) => {
                    let spk = r.speaker;
                    let m = metrics[spk] || {};
                    let exp = explanations[spk] || { strengths: [], weaknesses: [] };
                    let color = getSpeakerColor(spk);

                    let wpm = (m.avg_duration_per_turn_sec > 0) ? Math.round((m.avg_words_per_turn / m.avg_duration_per_turn_sec) * 60) : 0;

                    let s_raw = m.sentiment_score || 0;
                    let p_pos = Math.max(0, s_raw) * 100;
                    let p_neg = Math.max(0, -s_raw) * 100;
                    let p_neu = 100 - (p_pos + p_neg);
                    if (p_neu < 0) p_neu = 0;

                    let strHTML = exp.strengths.slice(0, 3).map(s => `<div class="sw-item"><i class="fa-solid fa-circle-plus sw-pos"></i>${s}</div>`).join('');
                    let weakHTML = exp.weaknesses.slice(0, 3).map(w => `<div class="sw-item"><i class="fa-solid fa-circle-minus sw-neg"></i>${w}</div>`).join('');

                    accHTML += `
                        <div class="speaker-card">
                            <button class="speaker-accordion-btn" data-bs-toggle="collapse" data-bs-target="#spk-${idx}">
                                <div class="d-flex align-items-center">
                                    <div class="avatar-ring" style="border-color:${color}">${spk.charAt(0).toUpperCase()}</div>
                                    <span style="font-weight: 500;" data-role="spk-name">${spk}</span>
                                </div>
                                <div>
                                    <span class="text-muted-custom me-3" style="font-size: 0.8rem;">Score: ${r.score}</span>
                                    <i class="fa-solid fa-chevron-down text-muted-custom"></i>
                                </div>
                            </button>
                            <div id="spk-${idx}" class="collapse bg-base">
                                <div class="p-3 border-top border-subtle">
                                    
                                    <div class="row g-3 mb-3 text-center">
                                        <div class="col-4"><div class="data-grid-item"><div class="text-muted-custom" style="font-size:0.7rem;">EST WPM</div><div class="fs-5 text-main">${wpm}</div></div></div>
                                        <div class="col-4"><div class="data-grid-item"><div class="text-muted-custom" style="font-size:0.7rem;">VOCAB</div><div class="fs-5 text-main">${m.vocabulary_richness || 0}</div></div></div>
                                        <div class="col-4"><div class="data-grid-item"><div class="text-muted-custom" style="font-size:0.7rem;">COVERAGE</div><div class="fs-5 text-main">${m.topic_coverage_percent || 0}%</div></div></div>
                                    </div>

                                    <div class="row g-3">
                                        <div class="col-12 col-md-4 d-flex flex-column justify-content-center align-items-center">
                                            <div style="height: 120px; width: 100%;"><canvas id="radar-${idx}"></canvas></div>
                                        </div>
                                        <div class="col-12 col-md-8">
                                            <div class="row g-2">
                                                <div class="col-6">
                                                    <div class="text-uppercase text-muted-custom mb-2" style="font-size:0.7rem;">Strengths</div>
                                                    ${strHTML}
                                                </div>
                                                <div class="col-6">
                                                    <div class="text-uppercase text-muted-custom mb-2" style="font-size:0.7rem;">Weaknesses</div>
                                                    ${weakHTML}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                </div>
                            </div>
                        </div>
                    `;

                    radarInitData.push({
                        idx: idx,
                        data: [Math.round(p_pos), Math.round(p_neu), Math.round(p_neg)],
                        color: color
                    });
                });
                $('#speakerAccordions').html(accHTML);

                radarInitData.forEach(ri => {
                    userCharts[`radar_${ri.idx}`] = new Chart(document.getElementById(`radar-${ri.idx}`).getContext('2d'), {
                        type: 'polarArea',
                        data: {
                            labels: ['Positive', 'Neutral', 'Negative'],
                            datasets: [{
                                data: ri.data,
                                backgroundColor: ['rgba(16, 185, 129, 0.4)', 'rgba(245, 158, 11, 0.4)', 'rgba(244, 63, 94, 0.4)'],
                                borderColor: ['#10b981', '#f59e0b', '#f43f5e'],
                                borderWidth: 1
                            }]
                        },
                        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { r: { display: false } } }
                    });
                });

                // 6. Interaction Dynamics Radar
                let iLabels = shareLabels;
                let interactScores = [];
                let alignScores = [];
                let totalSenti = 0;

                final_scores.ranking.forEach(r => {
                    let m = metrics[r.speaker] || {};
                    let s = analysis.speaker_scores ? analysis.speaker_scores[r.speaker] : {};
                    let inter = s && s.interaction_score ? s.interaction_score * 10 : (m.speaking_share_percent || 0);
                    interactScores.push(inter);
                    alignScores.push(m.agenda_alignment_percent || 0);
                    totalSenti += m.sentiment_score || 0;
                });

                interactionRadar = new Chart(document.getElementById('interactionRadarChart').getContext('2d'), {
                    type: 'radar',
                    data: {
                        labels: iLabels,
                        datasets: [
                            { label: 'Interaction Density', data: interactScores, backgroundColor: 'rgba(6, 182, 212, 0.2)', borderColor: '#06b6d4' },
                            { label: 'Topic Alignment', data: alignScores, backgroundColor: 'rgba(139, 92, 246, 0.2)', borderColor: '#8b5cf6' }
                        ]
                    },
                    options: { responsive: true, maintainAspectRatio: false, scales: { r: { angleLines: { color: '#1e293b' }, grid: { color: '#1e293b' } } } }
                });

                // Sliders
                let avgSenti = totalSenti / Math.max(1, shareLabels.length);
                let agreementPct = ((avgSenti + 1) / 2) * 100;
                $('#conflictSlider').css('width', agreementPct + '%');
                $('#conflictSlider').css('background-color', agreementPct > 50 ? '#10b981' : '#f43f5e');

                let avgScore = final_scores.ranking.reduce((sum, r) => sum + r.score, 0) / Math.max(1, shareLabels.length);
                let t_pct = Math.min(100, Math.round(avgScore * 0.8 + (actionList.length * 10)));
                $('#taskCompletionPct').text(t_pct + '%');
                $('#taskCompletionGauge').css('width', t_pct + '%');

            },
            error: function (xhr) {
                $('#loadingSection').hide();
                $('#uploadSectionContainer').show();

                let msg = "The server encountered an unexpected error.";
                let detail = "";
                try {
                    const resp = JSON.parse(xhr.responseText);
                    if (resp.error) msg = resp.error;
                    if (resp.detail) {
                        // Extract just the last meaningful line from the traceback
                        const lines = resp.detail.trim().split('\n').filter(l => l.trim());
                        detail = lines[lines.length - 1];
                    }
                } catch (e) { }

                const errHTML = `
                    <div class="glass-panel p-4 hero-upload-card mx-auto mt-4" style="border-color: rgba(244,63,94,0.4);">
                        <div class="d-flex align-items-center mb-3">
                            <i class="fa-solid fa-triangle-exclamation me-3 fs-4" style="color: var(--sema-neg);"></i>
                            <h5 class="mb-0" style="color: var(--sema-neg);">Processing Failed</h5>
                        </div>
                        <div class="text-main mb-2" style="font-size:0.9rem;">${msg}</div>
                        ${detail ? `<div class="text-muted-custom" style="font-size:0.78rem; font-family: monospace; background: var(--bg-base); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border-subtle);">${detail}</div>` : ''}
                        <button class="btn glow-btn mt-3 w-100" onclick="location.reload()">
                            <i class="fa-solid fa-rotate-left me-2"></i>Try Again
                        </button>
                    </div>
                `;
                $('#uploadSectionContainer').append(errHTML);
            }
        });
    });

    // -----------------------------------------------
    // RENAME BUTTON CLICK (delegated, works on injected HTML)
    // -----------------------------------------------
    $(document).on('click', '.speaker-rename-btn', function () {
        const originalSpeaker = $(this).data('original-speaker');
        const inputId = $(this).data('input-id');
        const newName = $(`#${inputId}`).val().trim();

        if (!newName) {
            $(`#${inputId}`).addClass('is-invalid');
            setTimeout(() => $(`#${inputId}`).removeClass('is-invalid'), 1500);
            return;
        }

        applyRename(originalSpeaker, newName);

        // Visual feedback on button
        const btn = $(this);
        btn.html('<i class="fa-solid fa-check me-1"></i>Done!').addClass('btn-success-flash');
        setTimeout(() => {
            btn.html('<i class="fa-solid fa-check me-1"></i>Apply').removeClass('btn-success-flash');
        }, 1800);
    });

    // Allow pressing Enter in rename input
    $(document).on('keypress', '.speaker-rename-input', function (e) {
        if (e.which === 13) {
            $(this).siblings('.speaker-rename-btn').click();
        }
    });
});