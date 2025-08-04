import asyncio
from datetime import datetime, timedelta
import json
from bson import ObjectId

class SpendingAdvisor:
	def __init__(self, ai_engine, db):
		self.ai = ai_engine
		self.db = db
		self.cache = {}
		
	async def evaluate_purchase(self, user_id, item_data):
		cache_key = f"{user_id}-{item_data['category']}"
		if cache_key in self.cache:
			return self.cache[cache_key]
			
		context = await self._build_context(user_id)
		prompt = self._create_prompt(context, item_data)
		advice = await self.ai._get_ai_response(prompt)
		
		self.cache[cache_key] = advice
		try:
			parsed = json.loads(advice)
		except Exception as e:
			parsed = {
				"recommendation": "maybe",
				"reason": "AI response could not be parsed.",
				"alternatives": [],
				"impact": "unknown"
			}

		return parsed
	async def _build_context(self, user_id):
		now = datetime.utcnow()
		week_ago = now - timedelta(days=7)

		# Fetch user details
		user = self.db.users.find_one({'_id': ObjectId(user_id)}) or {}

		# Get past week's expenses
		weekly_spending = list(self.db.transactions.find({
			'user_id': user_id,
			'date': {'$gte': week_ago},
			'type': 'expense'
		}))

		# Calculate recent spending total
		recent_spending = sum(t['amount'] for t in weekly_spending)

		# Calculate days left until next income
		days_left = None
		daily_budget = None
		monthly_income = user.get('monthly_income', 0)

		if user.get('next_income_date'):
			try:
				days_left = (user['next_income_date'] - now).days
				if days_left > 0:
					daily_budget = round((monthly_income - recent_spending) / days_left, 2)
			except Exception:
				pass  # fallback silently

		return {
			"weekly_spending": weekly_spending,
			"goals": list(self.db.goals.find({
				'user_id': user_id,
				'is_completed': False
			})),
			"balance": self._calculate_balance(user_id),
			"days_left_until_income": days_left,
			"daily_budget_estimate": daily_budget
		}
	def _create_prompt(self, context, item):
		return f"""Should a university student make this purchase?
		
		Item: {item['description']} (${item['amount']})
		Category: {item['category']}
		
		Context:
		- Weekly spending: ${sum(t['amount'] for t in context['weekly_spending'])}
		- Active goals: {len(context['goals'])}
		- Current balance: ${context['balance']}
		
		Respond with JSON:
		{{
			"recommendation": "yes/no/maybe",
			"reason": "short explanation",
			"alternatives": ["suggested alternatives"],
			"impact": "effect on goals"
		}}
		"""

	def _calculate_balance(self, user_id):
		transactions = list(self.db.transactions.find({'user_id': user_id}))
		
		income = sum(t['amount'] for t in transactions if t['type'] == 'income')
		expenses = sum(t['amount'] for t in transactions if t['type'] == 'expense')

		return round(income - expenses, 2)