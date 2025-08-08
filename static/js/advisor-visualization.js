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
            }
        });
    }

    static initCategoryChart() {
        const ctx = document.getElementById('categoryChart');
        if (!ctx) return;

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
                    y: { beginAtZero: true }
                },
                plugins: {
                    title: {
                        display: true,
                        text: 'Spending by Category'
                    }
                }
            }
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
            this.charts.impact.data.datasets[0].data = [
                data.impact.followed_count,
                data.impact.ignored_count
            ];
            this.charts.impact.update();
        }

        // Update category chart
        if (this.charts.category) {
            this.charts.category.data.labels = data.categories.map(c => c._id);
            this.charts.category.data.datasets[0].data = data.categories.map(c => c.total_amount);
            this.charts.category.data.datasets[1].data = data.categories.map(c => c.avg_amount);
            this.charts.category.update();
        }

        // Update trend chart
        if (this.charts.trend) {
            this.charts.trend.data.labels = data.trend.weeks;
            this.charts.trend.data.datasets[0].data = data.trend.amounts;
            this.charts.trend.update();
        }
    }

    static renderGoalImpact(impactData) {
        const container = document.getElementById('goal-impact-container');
        if (!container) return;

        container.innerHTML = impactData.goals.map(goal => `
            <div class="card mb-3">
                <div class="card-body">
                    <h5 class="card-title">${goal.description}</h5>
                    <p class="card-text">
                        Following advice could contribute ${goal.potential_progress.toFixed(1)}% 
                        towards your ${goal.type} goal ($${goal.target_amount})
                    </p>
                    <div class="progress">
                        <div class="progress-bar" 
                             role="progressbar" 
                             style="width: ${goal.potential_progress}%" 
                             aria-valuenow="${goal.potential_progress}" 
                             aria-valuemin="0" 
                             aria-valuemax="100">
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    }
}