class AIDashboard {
    static init() {
        this.loadPriorityVisualization();
        this.setupPurchaseAdvisor();
    }

    static async loadPriorityVisualization() {
        const response = await fetch('/api/goals/prioritized');
        const goals = await response.json();
        
        goals.forEach(goal => {
            const element = document.getElementById(`goal-${goal._id}`);
            if (element) {
                element.style.order = 100 - goal.ai_priority;
                element.dataset.priority = goal.ai_priority;
				element.style.setProperty('--priority', goal.ai_priority);
            }
        });
    }

    static setupPurchaseAdvisor() {
        document.getElementById('purchase-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = {
                description: e.target.elements.description.value,
                amount: parseFloat(e.target.elements.amount.value),
                category: e.target.elements.category.value
            };

            const response = await fetch('/api/ai/purchase-advice', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(formData)
            });

            const advice = await response.json();
            this.displayAdvice(advice);
        });
    }

    static displayAdvice(advice) {
        const adviceBox = document.createElement('div');
        adviceBox.className = `ai-advice ${advice.recommendation}`;
        adviceBox.innerHTML = `
            <h5>AI Recommendation: ${advice.recommendation.toUpperCase()}</h5>
            <p>${advice.reason}</p>
            ${advice.alternatives.length ? `
                <p>Alternatives: ${advice.alternatives.join(', ')}</p>
            ` : ''}
            <small>Impact: ${advice.impact}</small>
        `;
        document.getElementById('ai-feedback').appendChild(adviceBox);
    }
}

document.addEventListener('DOMContentLoaded', () => AIDashboard.init());
