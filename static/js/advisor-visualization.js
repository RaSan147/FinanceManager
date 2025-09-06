// Improved readability with proper indentation and comments
class FinanceVisualizer {
    static init() {
        this.charts = {};
        this.initImpactChart();
        this.initCategoryChart();
        this.initTrendChart();
    }

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
                    const datasets = chart?.data?.datasets || [];
                    const values = (datasets[0]?.data || []).map(Number);
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
                    c.fillStyle = '#6c757d'; // muted
                    c.font = '14px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
                    c.fillText('No data yet', x, y);
                    c.restore();
                } catch (_) {
                    // noop
                }
            }
        };

        this.charts.impact = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Followed Advice', 'Ignored Advice'],
                datasets: [{
                    data: [0, 0], // Will be updated
                    backgroundColor: ['#4bc0c0', '#ff6384'],
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: 'Advice Impact (30 Days)'
                    }
                }
            },
            plugins: [noDataPlugin]
        });
    }

    static initCategoryChart() {
        const ctx = document.getElementById('categoryChart');
        if (!ctx) return;

        const noDataPlugin = {
            id: 'noDataOverlayCategory',
            afterDraw(chart) {
                try {
                    const labels = chart?.data?.labels || [];
                    const ds0 = chart?.data?.datasets?.[0]?.data || [];
                    const ds1 = chart?.data?.datasets?.[1]?.data || [];
                    const total = [...ds0, ...ds1].reduce((a, b) => a + (Number(b) || 0), 0);

                    if ((labels.length === 0) || total === 0) {
                        const { ctx: c, chartArea } = chart;
                        if (!chartArea) return;

                        const { left, right, top, bottom } = chartArea;
                        const x = (left + right) / 2;
                        const y = (top + bottom) / 2;

                        c.save();
                        c.textAlign = 'center';
                        c.textBaseline = 'middle';
                        c.fillStyle = '#6c757d';
                        c.font = '14px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
                        c.fillText('No category data', x, y);
                        c.restore();
                    }
                } catch (_) {
                    // noop
                }
            }
        };

        this.charts.category = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{
                    label: 'Total Amount',
                    data: [],
                    backgroundColor: '#36a2eb'
                }, {
                    label: 'Average Amount',
                    data: [],
                    backgroundColor: '#ffcd56'
                }]
            },
            options: {
                responsive: true,
                scales: {
                    x: { stacked: true },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return window.formatNumber ? window.formatNumber(value, 0) : value;
                            }
                        }
                    }
                },
                plugins: {
                    title: {
                        display: true,
                        text: 'Spending by Category'
                    }
                }
            },
            plugins: [noDataPlugin]
        });
    }

    static initTrendChart() {
        const ctx = document.getElementById('trendChart');
        if (!ctx) return;

        this.charts.trend = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Weekly Spending',
                    data: [],
                    borderColor: '#9966ff',
                    fill: false
                }]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        ticks: {
                            callback: function(value) {
                                return window.formatNumber ? window.formatNumber(value, 0) : value;
                            }
                        }
                    }
                },
                plugins: {
                    title: {
                        display: true,
                        text: 'Spending Trend'
                    }
                }
            }
        });
    }

    static updateCharts(data) {
        // Update impact chart
        if (this.charts.impact) {
            const followed = Number(data?.impact?.followed_count) || 0;
            const ignored = Number(data?.impact?.ignored_count) || 0;
            this.charts.impact.data.datasets[0].data = [followed, ignored];
            this.charts.impact.update();
        }

        // Update category chart
        if (this.charts.category) {
            const cats = Array.isArray(data?.categories) ? data.categories : [];
            if (cats.length === 0) {
                // Reset to empty to trigger no-data overlay
                this.charts.category.data.labels = [];
                this.charts.category.data.datasets[0].data = [];
                this.charts.category.data.datasets[1].data = [];
            } else {
                this.charts.category.data.labels = cats.map(c => c?._id ?? 'Uncategorized');
                this.charts.category.data.datasets[0].data = cats.map(c => Number(c?.total_amount) || 0);
                this.charts.category.data.datasets[1].data = cats.map(c => Number(c?.avg_amount) || 0);
            }
            this.charts.category.update();
        }

        // Update trend chart
        if (this.charts.trend) {
            const weeks = data?.trend?.weeks || [];
            const amounts = data?.trend?.amounts || [];
            this.charts.trend.data.labels = Array.isArray(weeks) ? weeks : [];
            this.charts.trend.data.datasets[0].data = Array.isArray(amounts) ? amounts.map(n => Number(n) || 0) : [];
            this.charts.trend.update();
        }
    }

    static renderGoalImpact(impactData) {
        const container = document.getElementById('goal-impact-container');
        if (!container) return;

        // Guard for missing or empty data
        const goals = (impactData && Array.isArray(impactData.goals)) ? impactData.goals : [];
        const meaningful = goals.filter(g => Number(g?.potential_progress) > 0);
        if (meaningful.length === 0) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }
        container.style.display = '';

        container.innerHTML = meaningful.map(goal => {
            const rawProgress = Number(goal?.potential_progress);
            const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, rawProgress)) : 0;
            const title = goal?.description || (goal?.type ? `${goal.type.charAt(0).toUpperCase()}${goal.type.slice(1)} goal` : 'Goal');
            const target = Number(goal?.target_amount) || 0;
            return `
            <div class="card mb-3">
                <div class="card-body">
                    <h5 class="card-title">${title}</h5>
                    <p class="card-text">
                        Following advice could contribute ${progress.toFixed(1)}% 
                        towards your ${goal?.type || 'savings'} goal (${formatMoney(target, '$')})
                    </p>
                    <div class="progress">
                        <div class="progress-bar" 
                             role="progressbar" 
                             style="width: ${progress}%" 
                             aria-valuenow="${progress}" 
                             aria-valuemin="0" 
                             aria-valuemax="100">
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }
}