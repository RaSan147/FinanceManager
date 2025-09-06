class Goal {
    constructor(data, helpers) {
        this.data = data;
        this.helpers = helpers;
        this.currencySymbol = window.currencySymbols?.[this.data.currency] || window.currencySymbol || '$';
    }

    render() {
        const {
            safeDateString,
            fmt,
            cap,
            createEl,
            escapeHtml
        } = this.helpers;
        const g = this.data;
        const p = g.progress || {};
        const percent = Number(p.progress_percent || 0);
        const percentWidth = Math.max(0, Math.min(100, percent));
        const barClass = percent >= 75 ? 'bg-success' : percent >= 40 ? 'bg-warning' : 'bg-danger';
        const saved = p.current_amount ?? g.current_amount ?? 0;
        const target = g.target_amount || 0;
        const due = safeDateString(g.target_date);

        const item = createEl('div', {
            class: 'list-group-item',
            dataset: {
                goalId: g._id || g.id
            }
        });

        const top = createEl('div', {
            class: 'd-flex justify-content-between align-items-start'
        });
        const left = createEl('div');
        const right = createEl('div', {
            class: 'text-end goal-meta-block'
        });

        left.appendChild(createEl('h5', {
            class: 'mb-1'
        }, g.description || ''));

        const meta = createEl('div', {
            class: 'mb-1'
        });
        meta.appendChild(createEl('span', {
            class: 'badge ' + (g.is_completed ? 'bg-success' : 'bg-primary')
        }, g.type ? cap(g.type) : 'Goal'));
        meta.appendChild(createEl('span', {
            class: 'text-muted ms-2'
        }, `Target: ${this.currencySymbol}${fmt(target)}`));
        left.appendChild(meta);

        const dueEl = createEl('small', {
            class: 'text-muted'
        }, 'Due: ' + due);
        left.appendChild(dueEl);

        if (p.overdue_months) {
            left.appendChild(createEl('span', {
                class: 'badge bg-danger ms-1'
            }, `Overdue ${p.overdue_months} mo`));
        }

        const progBar = createEl('div', {
            class: 'progress-bar ' + barClass,
            style: `width: ${percentWidth}%`
        }, `${percent.toFixed(1)}%`);
        right.appendChild(createEl('div', {
            class: 'progress mb-1',
            style: 'height: 20px'
        }, progBar));

        const smallWrap = createEl('div', {
            class: 'small text-muted'
        });
        smallWrap.appendChild(createEl('div', {}, `Saved: ${this.currencySymbol}${fmt(saved)} / ${this.currencySymbol}${fmt(target)}`));
        if (p.required_monthly) {
            const reqText = `Req/mo: ${this.currencySymbol}${fmt(p.required_monthly)}`;
            const currentText = p.current_monthly ? ` | Current/mo: ${this.currencySymbol}${fmt(p.current_monthly)}` : '';
            smallWrap.appendChild(createEl('div', {}, reqText + currentText));
        }
        right.appendChild(smallWrap);

        top.appendChild(left);
        top.appendChild(right);
        item.appendChild(top);

        if (this.hasAiData(g)) {
            item.appendChild(this.renderAIBadges(g));
        }

        if (g.ai_plan) {
            const details = createEl('details', {
                class: 'mt-2'
            });
            details.appendChild(createEl('summary', {
                class: 'small text-primary'
            }, 'AI Plan'));
            const planBody = createEl('div', {
                class: 'small mt-1'
            });
            planBody.innerHTML = escapeHtml(g.ai_plan).replace(/\n/g, '<br>');
            details.appendChild(planBody);
            item.appendChild(details);
        }

        item.appendChild(this.renderActions(g));

        return item;
    }

    hasAiData(g) {
        return ['ai_priority', 'ai_urgency', 'ai_impact', 'ai_health_impact', 'ai_confidence'].some(k => g[k] != null) ||
            (g.ai_suggestions && g.ai_suggestions.length) ||
            g.ai_summary;
    }

    renderAIBadges(g) {
        const {
            createEl
        } = this.helpers;
        const wrap = createEl('div', {
            class: 'mt-2'
        });

        const addBadge = (cls, text) => {
            wrap.appendChild(createEl('span', {
                class: `badge ${cls} me-1`
            }, text));
        };

        if (g.ai_priority != null) addBadge('bg-info text-dark', `Priority ${Number(g.ai_priority).toFixed(0)}`);
        if (g.ai_urgency != null) addBadge('bg-warning text-dark', `Urgency ${Number(g.ai_urgency).toFixed(2)}`);
        if (g.ai_impact != null) addBadge('bg-success text-dark', `Impact ${Number(g.ai_impact).toFixed(2)}`);
        if (g.ai_health_impact != null && g.ai_health_impact > 0) addBadge('bg-danger text-dark', `Health ${Number(g.ai_health_impact).toFixed(2)}`);
        if (g.ai_confidence != null) addBadge('bg-secondary text-light', `Conf ${Number(g.ai_confidence).toFixed(2)}`);

        if (g.ai_suggestions && g.ai_suggestions.length) {
            const ul = createEl('ul', {
                class: 'mt-2 small'
            });
            g.ai_suggestions.forEach(s => ul.appendChild(createEl('li', {}, s)));
            wrap.appendChild(ul);
        }

        if (g.ai_summary) {
            wrap.appendChild(createEl('div', {
                class: 'small text-muted mt-1'
            }, g.ai_summary));
        }
        return wrap;
    }

    renderActions(g) {
        const {
            createEl
        } = this.helpers;
        const actions = createEl('div', {
            class: 'd-flex justify-content-end gap-2 mt-2'
        });

        if (!g.is_completed) {
            actions.appendChild(createEl('button', {
                class: 'btn btn-sm btn-outline-success action-btn',
                dataset: { goalComplete: g._id || g.id }
            }, 'Complete'));
            actions.appendChild(createEl('button', {
                class: 'btn btn-sm btn-outline-secondary action-btn',
                dataset: { goalRevalidate: g._id || g.id }
            }, 'Revalidate'));
        }
        actions.appendChild(createEl('button', {
            class: 'btn btn-sm btn-outline-danger action-btn',
            dataset: { goalDelete: g._id || g.id }
        }, 'Delete'));

        actions.addEventListener('click', e => {
            const target = e.target.closest('button');
            if (!target) return;
            const {
                goalComplete,
                goalRevalidate,
                goalDelete
            } = target.dataset;
            if (goalComplete) GoalsModule.doComplete(goalComplete);
            else if (goalRevalidate) GoalsModule.doRevalidate(goalRevalidate);
            else if (goalDelete) GoalsModule.doDelete(goalDelete);
        });

        return actions;
    }
}


class GoalsModule {
    static init(utils) {
        this.utils = utils;
        this.state = {
            page: 1,
            perPage: 5,
            total: 0
        };
        if (this.utils.qs('[data-goals-root]')) {
            this.initGoalsPage();
        }
    }

    static initGoalsPage() {
        const {
            qs
        } = this.utils;
        const addForm = qs('[data-goal-form]');
        if (addForm) {
            addForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const fd = new FormData(addForm);
                const payload = {
                    goal_type: fd.get('goal_type'),
                    target_amount: fd.get('target_amount'),
                    description: fd.get('description'),
                    target_date: fd.get('target_date'),
                    target_currency: fd.get('target_currency')
                };
                try {
                    await this.utils.fetchJSON('/api/goals', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    });
                    window.flash && window.flash('Goal added', 'success');
                    addForm.reset();
                    this.loadGoals(1);
                } catch (err) {
                    window.flash && window.flash('Add failed', 'danger');
                }
            });
        }

        qs('[data-goals-pagination]')?.addEventListener('click', e => {
            const a = e.target.closest('a[data-page]');
            if (!a) return;
            e.preventDefault();
            this.loadGoals(parseInt(a.dataset.page, 10));
        });

        this.loadGoals(1);
    }

    static async loadGoals(page) {
        const {
            qs,
            fetchJSON
        } = this.utils;
        const root = qs('[data-goals-list]');
        if (!root) return;
        const perPage = parseInt(root.getAttribute('data-per-page') || '5', 10);

        try {
            const data = await fetchJSON(`/api/goals/list?page=${page}&per_page=${perPage}`);
            this.state.page = data.page;
            this.state.perPage = data.per_page;
            this.state.total = data.total;
            this.renderGoals(data.items || []);
            this.renderPagination();
        } catch (e) {
            root.innerHTML = '<div class="text-danger">Failed to load goals</div>';
        }
    }

    static renderGoals(items) {
        const {
            qs
        } = this.utils;
        const root = qs('[data-goals-list]');
        if (!root) return;

        root.innerHTML = '';

        if (!items.length) {
            root.innerHTML = '<div class="text-center py-4 text-muted">No goals yet.</div>';
            return;
        }

        const frag = document.createDocumentFragment();
        items.forEach(itemData => {
            try {
                const goal = new Goal(itemData, this.helpers());
                frag.appendChild(goal.render());
            } catch (e) {
                console.warn('Bad goal entry skipped', itemData, e);
            }
        });
        root.appendChild(frag);
    }

    static renderPagination() {
        const {
            qs,
            createEl
        } = this.utils;
        const wrap = qs('[data-goals-pagination]');
        if (!wrap) return;

        const totalPages = Math.ceil(this.state.total / this.state.perPage);
        wrap.innerHTML = '';
        if (totalPages <= 1) return;

        const ul = createEl('ul', {
            class: 'pagination justify-content-center mt-3'
        });

        const createPageItem = (text, page, isActive = false, isDisabled = false) => {
            const li = createEl('li', {
                class: `page-item ${isActive ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`
            });
            const a = createEl('a', {
                class: 'page-link',
                href: '#',
                dataset: {
                    page
                }
            }, text);
            li.appendChild(a);
            return li;
        };

        if (this.state.page > 1) {
            ul.appendChild(createPageItem('Previous', this.state.page - 1));
        }

        for (let p = 1; p <= totalPages; p++) {
            ul.appendChild(createPageItem(p, p, p === this.state.page));
        }

        if (this.state.page < totalPages) {
            ul.appendChild(createPageItem('Next', this.state.page + 1));
        }

        wrap.appendChild(ul);
    }

    static async doComplete(id) {
        try {
            await this.utils.fetchJSON(`/api/goals/${id}/complete`, {
                method: 'POST'
            });
            window.flash && window.flash('Goal completed', 'success');
            this.loadGoals(this.state.page);
        } catch (err) {
            window.flash && window.flash('Complete failed', 'danger');
        }
    }

    static async doDelete(id) {
        if (!confirm('Are you sure you want to delete this goal?')) return;
        try {
            await this.utils.fetchJSON(`/api/goals/${id}`, {
                method: 'DELETE'
            });
            window.flash && window.flash('Goal deleted', 'success');
            this.loadGoals(this.state.page);
        } catch (err) {
            window.flash && window.flash('Delete failed', 'danger');
        }
    }

    static async doRevalidate(id) {
        try {
            await this.utils.fetchJSON(`/api/goals/${id}/revalidate`, {
                method: 'POST'
            });
            window.flash && window.flash('Revalidation started', 'info');
        } catch (err) {
            window.flash && window.flash('Revalidation failed', 'danger');
        }
    }

    static helpers() {
        return this.utils;
    }
}

App.register(GoalsModule);

