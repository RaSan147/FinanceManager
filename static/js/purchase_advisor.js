class PurchaseAdvisor {
    static init() {
        this.setupForm();
        this.loadRecommendationHistory();
        this.loadVisualizationData();
        this.setupArchiveButton();
		
        // Build currency symbol map from the select options if available
        const sel = document.getElementById('currency');
        this.currencySymbolMap = {};
        if (sel) {
            Array.from(sel.options).forEach(opt => {
                if (opt.value) {
                    this.currencySymbolMap[opt.value] = opt.dataset?.symbol || '';
                }
            });
        }

        FinanceVisualizer.init();
    }

    static async loadVisualizationData() {
        try {
            const response = await fetch('/api/ai/visualization-data');
            if (!response.ok) throw new Error('Failed to load visualization data');
            
            const data = await response.json();
            FinanceVisualizer.updateCharts(data);
            if (data && data.goal_impact) {
                FinanceVisualizer.renderGoalImpact(data.goal_impact);
            }
        } catch (error) {
            console.error('Error loading visualization data:', error);
        }
    }

    static setupForm() {
        const form = document.getElementById('purchase-form');
        if (!form) return;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!form.checkValidity()) {
                e.stopPropagation();
                form.classList.add('was-validated');
                return;
            }

            const submitBtn = form.querySelector('button[type="submit"]');
            const spinner = document.getElementById('spinner');
            submitBtn.disabled = true;
            spinner.classList.remove('d-none');

            try {
                // Collect tags from TagManager (advisor-tagging.js)
                const tags = window.TagManager ? window.TagManager.getTags() : [];

                const formData = {
                    description: form.elements.description?.value,
                    amount: parseFloat(form.elements.amount?.value),
                    currency: form.elements.currency?.value,
                    category: form.elements.category?.value || undefined,
                    urgency: form.elements.urgency?.value,
                    tags: tags.length ? tags : undefined
                };

                const response = await fetch('/api/ai/purchase-advice', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(formData)
                });

                if (!response.ok) {
                    const err = await response.json();
                    if (err && err.error) {
                        window.flash(err.error, 'danger');
                    }
                    throw new Error('API request failed');
                }
                const advice = await response.json();
                this.displayAdvice(advice);
                this.loadVisualizationData();
                this.loadRecommendationHistory();
                window.flash('Advice received!', 'success');
            } catch (error) {
                console.error('Error getting purchase advice:', error);
                this.showError();
                window.flash('Could not get advice at this time.', 'danger');
            } finally {
                submitBtn.disabled = false;
                spinner.classList.add('d-none');
            }
        });
    }

    static displayAdvice(advice, targetEl) {
        // If a target container is provided, render there; otherwise fallback to the main feedback area
        const container = targetEl || document.getElementById('ai-feedback');
        if (!container) return;
        container.innerHTML = '';

        // Normalize/adapt incoming advice object to safe defaults
        const safe = Object.assign({
            recommendation: 'unknown',
            reason: 'Unavailable.',
            impact: 'N/A',
            alternatives: [],
            amount_converted: null,
            base_currency: null,
            suggested_budget: null
        }, advice || {});

        const adviceBox = document.createElement('div');
        adviceBox.className = `ai-advice ${safe.recommendation}`;
        
        // Only show a prominent icon for concrete recommendations (yes/no/maybe).
        let icon = '';
        if (safe.recommendation === 'yes') icon = '✅';
        if (safe.recommendation === 'no') icon = '❌';
        if (safe.recommendation === 'maybe') icon = '⚠️';

        adviceBox.innerHTML = `
            <div class="d-flex align-items-center mb-2">
                ${icon ? `<span class="fs-3 me-2">${icon}</span>` : ''}
                <h4 class="mb-0">Recommendation: ${this.capitalize(safe.recommendation)}</h4>
            </div>
            <div class="ms-4">
                <p class="mb-2"><strong>Reason:</strong> ${safe.reason}</p>
                ${safe.amount_converted != null && safe.base_currency ? `<p class="mb-2"><strong>Amount (base):</strong> ${formatNumber(safe.amount_converted, 2)} ${safe.base_currency}</p>` : ''}
                ${safe.alternatives?.length ? `
                    <div class="mb-2"><strong>Alternatives:</strong>
                        <ul class="mb-0 ps-4">
                            ${safe.alternatives.map(alt => `<li>${alt}</li>`).join('')}
                        </ul>
                    </div>
                ` : ''}
                <p class="mb-0"><strong>Impact:</strong> ${safe.impact}</p>
                ${safe.suggested_budget ? `
                    <div class="mt-3">
                        <p class="mb-1"><strong>Suggested Budget Adjustment:</strong></p>
                        <p class="mb-0">${safe.suggested_budget}</p>
                    </div>
                ` : ''}
            </div>
        `;
        
        container.appendChild(adviceBox);
    }

    static showError() {
        const feedbackDiv = document.getElementById('ai-feedback');
        feedbackDiv.innerHTML = `
            <div class="ai-advice no">
                <h4>Error</h4>
                <p>Could not get advice at this time. Please try again later.</p>
            </div>
        `;
    }

    static capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

	
    static async loadRecommendationHistory() {
        // Pagination parameters
        const page = this.currentPage || 1;
        const pageSize = 5;
        try {
            const response = await fetch(`/api/ai/advice-history?page=${page}&page_size=${pageSize}`);
            if (!response.ok) throw new Error('Failed to load history');
            const result = await response.json();
            // result: { items: [...], total: N }
            this.renderHistory(result.items || [], result.total || 0, page, pageSize);
        } catch (error) {
            console.error('Error loading history:', error);
            this.renderHistory([], 0, page, pageSize);
        }
    }

    static renderHistory(history) {
        // history: array, total: int, page: int, pageSize: int
        const container = document.getElementById('recommendation-history');
        container.innerHTML = '';

        // Support for new signature
        let items = history, total = 0, page = 1, pageSize = 5;
        if (arguments.length > 1) {
            total = arguments[1];
            page = arguments[2] || 1;
            pageSize = arguments[3] || 5;
        }

        if (!items || items.length === 0) {
            container.innerHTML = `
                <div class="list-group-item text-muted">
                    No recommendations yet. Get your first advice above!
                </div>
            `;
        } else {
            items.forEach(item => {
                const element = document.createElement('div');
                element.className = `list-group-item list-group-item-action`;
                // Guard against missing/archived advice objects.
                // Prefer the full inline advice if present, otherwise use the lightweight advice_summary returned by the history API.
                const summary = item.advice || item.advice_summary || null;
                let icon = '';
                const itemRec = summary?.recommendation;
                if (itemRec === 'yes') icon = '✅';
                if (itemRec === 'no') icon = '❌';
                if (itemRec === 'maybe') icon = '⚠️';
                                                const date = window.SiteDate.toDateTimeString(item.created_at);
                const srcAmount = (item?.request?.amount_original ?? item?.request?.amount);
                const amtNum = Number(srcAmount);
                const amountSafe = Number.isFinite(amtNum) ? amtNum : 0;
                const reqCurrency = (item?.request?.currency || window.defaultCurrency || 'USD');
                const sym = this.currencySymbolMap?.[reqCurrency] || '$';
                const status = item.user_action === 'followed'
                    ? '<span class="badge rounded-pill bg-success me-2">Followed</span>'
                    : (item.user_action === 'ignored'
                        ? '<span class="badge rounded-pill bg-secondary me-2">Ignored</span>'
                        : '');
                const detailsId = `rec-${item._id}`;
                element.innerHTML = `
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            ${status}
                            ${icon ? `<span class="me-2">${icon}</span>` : ''}
                            <strong>${item.request.description}</strong>
                            <span class="text-muted ms-2">${formatMoney(amountSafe, sym)}</span>
                        </div>
                        <div class="d-flex align-items-center">
                            <small class="text-muted me-2">${date}</small>
                            <button class="btn btn-sm btn-danger delete-btn" data-id="${item._id}" title="Delete">
                                <i class="fa-solid fa-trash" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>
                    ${item.pastebin_url ? `
                        <div class="mt-2">
                            <small>Archived at: </small>
                            <a href="${item.pastebin_url}" target="_blank" class="small">View Archive</a>
                        </div>
                    ` : ''}
                    <div id="${detailsId}" class="recommendation-details d-none mt-2"></div>
                `;
                // Add Followed/Ignored buttons
                const actionBtns = document.createElement('div');
                actionBtns.className = 'btn-group btn-group-sm ms-2';
                ['followed', 'ignored'].forEach(action => {
                    const btn = document.createElement('button');
                    const isSelected = item.user_action === action;
                    btn.className = `btn btn-outline-${action === 'followed' ? 'success' : 'secondary'}${isSelected ? ' is-selected' : ''}`;
                    btn.textContent = action.charAt(0).toUpperCase() + action.slice(1);
                    btn.disabled = isSelected; // prevent re-post of same state
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await fetch(`/api/ai/advice/${item._id}/action`, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({action})
                        });
                        // Refresh history for visual state and refresh charts dynamically
                        this.loadRecommendationHistory();
                        this.loadVisualizationData();
                    });
                    actionBtns.appendChild(btn);
                });
                element.querySelector('.d-flex > div:last-child').appendChild(actionBtns);
                element.addEventListener('click', async (e) => {
                    if (!e.target.closest('.delete-btn') && !e.target.closest('.btn-group') && !e.target.closest('a')) {
                        // Toggle inline details like an accordion
                        const details = element.querySelector(`#${detailsId}`);
                        const isHidden = details.classList.contains('d-none');
                        // Collapse other open details in the list
                        container.querySelectorAll('.recommendation-details').forEach(d => {
                            if (d !== details) d.classList.add('d-none');
                        });
                        if (isHidden) {
                            // If full advice missing, but advice_summary exists, show that immediately
                            if (!item.advice && item.advice_summary) {
                                this.displayAdvice({
                                    recommendation: item.advice_summary.recommendation || 'unknown',
                                    reason: item.advice_summary.reason || 'Unavailable.',
                                    impact: item.advice_summary.impact || 'N/A',
                                    amount_converted: item.advice_summary.amount_converted,
                                    base_currency: item.advice_summary.base_currency
                                }, details);
                            }
                            // Lazy load if offloaded (no local advice key but pastebin_url present)
                            if(!item.advice && item.pastebin_url){
                                // show a loading indicator while fetching full content
                                details.innerHTML = '<div class="text-muted small">Loading archived advice...</div>';
                                try {
                                    const resp = await fetch(`/api/ai/advice/${item._id}`);
                                    if(resp.ok){
                                        const data = await resp.json();
                                        if(data.advice){
                                            item.advice = data.advice; // cache for this session
                                            this.displayAdvice(item.advice, details);
                                        }
                                    }
                                } catch(e){ console.error('Failed to load archived advice', e); }
                            }
                            // If no advice at all, show fallback
                            if(!item.advice && !item.advice_summary){
                                this.displayAdvice({ recommendation: 'unknown', reason: 'Unavailable.' }, details);
                            }
                            details.classList.remove('d-none');
                        } else {
                            details.classList.add('d-none');
                        }
                    }
                });
                element.querySelector('.delete-btn')?.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (confirm('Delete this recommendation?')) {
                        await this.deleteAdvice(item._id);
                    }
                });
                container.appendChild(element);
            });
        }

        // Pagination controls
        const totalPages = Math.ceil(total / pageSize);
        if (totalPages > 1) {
            const pagination = document.createElement('nav');
            pagination.className = 'mt-3';
            let html = '<ul class="pagination justify-content-center">';
            for (let i = 1; i <= totalPages; i++) {
                html += `<li class="page-item${i === page ? ' active' : ''}">
                    <a class="page-link" href="#" data-page="${i}">${i}</a>
                </li>`;
            }
            html += '</ul>';
            pagination.innerHTML = html;
            container.appendChild(pagination);
            pagination.addEventListener('click', (e) => {
                const link = e.target.closest('a.page-link');
                if (link) {
                    e.preventDefault();
                    const newPage = parseInt(link.getAttribute('data-page'));
                    if (!isNaN(newPage)) {
                        this.currentPage = newPage;
                        this.loadRecommendationHistory();
                    }
                }
            });
        } else {
            this.currentPage = 1;
        }
    }

    static async deleteAdvice(adviceId) {
        try {
            const response = await fetch(`/api/ai/advice/${adviceId}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                this.loadRecommendationHistory();
                this.loadVisualizationData();
            }
        } catch (error) {
            console.error('Error deleting advice:', error);
        }
    }

    static setupArchiveButton() {
        document.getElementById('archive-old-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('archive-old-btn');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Archiving...';
            
            try {
                const response = await fetch('/api/ai/archive-old', {
                    method: 'POST'
                });
                
                if (response.ok) {
                    this.loadRecommendationHistory();
                    alert('Old entries archived successfully!');
                }
            } catch (error) {
                console.error('Error archiving:', error);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Archive Old Entries';
            }
        });
    }

}

document.addEventListener('DOMContentLoaded', () => PurchaseAdvisor.init());