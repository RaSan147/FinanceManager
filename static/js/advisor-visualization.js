/**
 * advisor-visualization.js
 * Chart rendering helpers and small DOM render utilities used by the advisor pages.
 * Keeps Chart.js instances under FinanceVisualizer.charts and exposes a handful of
 * methods: init(), updateCharts(data), renderGoalImpact(impactData).
 */
class FinanceVisualizer {
    /** Initialize chart holders and create charts */
    static init() {
        this.charts = {};
        this.initImpactChart();
        this.initCategoryChart();
        this.initTrendChart();
    }

    /** Create the doughnut chart for advice impact (followed vs ignored) */
    static initImpactChart() {
        const ctx = document.getElementById('impactChart');
        if (!ctx) return;

        if (typeof Chart === 'undefined') {
            console.error('Chart.js is not loaded');
            return;
        }

        const noDataPlugin = {
            id: 'noDataOverlay',
            afterDraw(chart) {
                try {
                    const values = (chart.data.datasets[0].data || []).map(Number);
                    const sum = values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
                    if (sum > 0) return;

                    const { ctx: c, chartArea } = chart;
                    if (!chartArea) return;
                    const { left, right, top, bottom } = chartArea;
                    const x = (left + right) / 2;
                    const y = (top + bottom) / 2;

                    c.save();
                    c.textAlign = 'center';
                    c.textBaseline = 'middle';
                    c.fillStyle = '#6c757d';
                    c.font = '14px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
                    c.fillText('No data yet', x, y);
                    c.restore();
                } catch (e) {
                    // Plugin should never break the page – swallow errors.
                }
            }
        };

        this.charts.impact = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Followed Advice', 'Ignored Advice'],
                datasets: [{
                    data: [0, 0],
                    backgroundColor: ['#4bc0c0', '#ff6384'],
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: { title: { display: true, text: 'Advice Impact (30 Days)' } }
            },
            plugins: [noDataPlugin]
        });
    }

    /** Create the stacked bar chart for spending by category */
    static initCategoryChart() {
        const ctx = document.getElementById('categoryChart');
        if (!ctx) return;

        const noDataPlugin = {
            id: 'noDataOverlayCategory',
            afterDraw(chart) {
                try {
                    const labels = chart.data.labels || [];
                    const ds0 = chart.data.datasets[0].data || [];
                    const ds1 = chart.data.datasets[1].data || [];
                    const total = [...ds0, ...ds1].reduce((a, b) => a + (Number(b) || 0), 0);
                    if (labels.length > 0 && total !== 0) return;

                    const { ctx: c, chartArea } = chart;
                    if (!chartArea) return;
                    const { left, right, top, bottom } = chartArea;
                    const x = (left + right) / 2;
                    const y = (top + bottom) / 2;

                    c.save();
                    c.textAlign = 'center';
                    c.textBaseline = 'middle';
                    c.fillStyle = '#6c757d';
                    c.font = '14px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
                    c.fillText('No category data', x, y);
                    c.restore();
                } catch (e) {
                    // noop
                }
            }
        };

        this.charts.category = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{ label: 'Total Amount', data: [], backgroundColor: '#36a2eb' },
                           { label: 'Average Amount', data: [], backgroundColor: '#ffcd56' }]
            },
            options: {
                responsive: true,
                scales: {
                    x: { stacked: true },
                    y: {
                        beginAtZero: true,
                        ticks: { callback(value) { return window.formatNumber ? window.formatNumber(value, 0) : value; } }
                    }
                },
                plugins: { title: { display: true, text: 'Spending by Category' } }
            },
            plugins: [noDataPlugin]
        });
    }

    /** Create the line chart for spending trend */
    static initTrendChart() {
        const ctx = document.getElementById('trendChart');
        if (!ctx) return;

        this.charts.trend = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{ label: 'Weekly Spending', data: [], borderColor: '#9966ff', fill: false }]
            },
            options: {
                responsive: true,
                scales: { y: { ticks: { callback(value) { return window.formatNumber ? window.formatNumber(value, 0) : value; } } } },
                plugins: { title: { display: true, text: 'Spending Trend' } }
            }
        });
    }

    /**
     * Update all charts from a data object.
     * Partial expected shape:
     * {
     *   impact: { followed_count, ignored_count },
     *   categories: [{ _id, total_amount, avg_amount }, ...],
     *   trend: { weeks: [...], amounts: [...] }
     * }
     */
    static updateCharts(data) {
        // Impact chart
        if (this.charts.impact) {
            const followed = Number(data.impact.followed_count) || 0;
            const ignored = Number(data.impact.ignored_count) || 0;
            this.charts.impact.data.datasets[0].data = [followed, ignored];
            this.charts.impact.update();
        }

        // Category chart
        if (this.charts.category) {
            const cats = Array.isArray(data.categories) ? data.categories : [];
            if (cats.length === 0) {
                // empty -> trigger no-data overlay
                this.charts.category.data.labels = [];
                this.charts.category.data.datasets[0].data = [];
                this.charts.category.data.datasets[1].data = [];
            } else {
                this.charts.category.data.labels = cats.map(c => c._id ?? 'Uncategorized');
                this.charts.category.data.datasets[0].data = cats.map(c => Number(c.total_amount) || 0);
                this.charts.category.data.datasets[1].data = cats.map(c => Number(c.avg_amount) || 0);
            }
            this.charts.category.update();
        }

        // Trend chart
        if (this.charts.trend) {
            const weeks = Array.isArray(data.trend.weeks) ? data.trend.weeks : [];
            const amounts = Array.isArray(data.trend.amounts) ? data.trend.amounts.map(n => Number(n) || 0) : [];
            this.charts.trend.data.labels = weeks;
            this.charts.trend.data.datasets[0].data = amounts;
            this.charts.trend.update();
        }
    }

    /**
     * Render small goal-impact cards into #goal-impact-container.
     * Only renders goals with meaningful potential_progress (> 0).
     */
    static renderGoalImpact(impactData) {
        const container = document.getElementById('goal-impact-container');
        if (!container) return;

    const goals = Array.isArray(impactData.goals) ? impactData.goals : [];
    const meaningful = goals.filter(g => Number(g.potential_progress) > 0);

        if (meaningful.length === 0) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }

        container.style.display = '';
        container.innerHTML = meaningful.map(goal => {
            const raw = Number(goal.potential_progress);
            const progress = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
            const title = goal.description || (goal.type ? goal.type.charAt(0).toUpperCase() + goal.type.slice(1) + ' goal' : 'Goal');
            const target = Number(goal.target_amount) || 0;
            const formattedTarget = (typeof formatMoney === 'function') ? formatMoney(target, '$') : target;

            return `
                <div class="card mb-3">
                    <div class="card-body">
                        <h5 class="card-title">${title}</h5>
                        <p class="card-text">Following advice could contribute ${progress.toFixed(1)}% towards your ${goal?.type || 'savings'} goal (${formattedTarget})</p>
                        <div class="progress">
                            <div class="progress-bar" role="progressbar" style="width: ${progress}%" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"></div>
                        </div>
                    </div>
                </div>`;
        }).join('');
    }
}