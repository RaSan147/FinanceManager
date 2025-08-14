import asyncio
import json
import time
import traceback
from google import genai
from datetime import datetime

class FinancialBrain:
    def __init__(self, api_key):
        self.client = genai.Client(api_key=api_key)
        self.model = "gemini-2.5-pro"

    def _get_ai_response(self, prompt):
        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = self.client.models.generate_content(
                    model=self.model,
                    contents=prompt
                )
                text = response.text.strip()
                if text.startswith("```json"):
                    text = text[8:].strip()
                    if text.endswith("```"):
                        text = text[:-3].strip()
                return text
            except Exception as e:
                if attempt == max_retries - 1:
                    return json.dumps({"error": str(e)})
                time.sleep(1 * (attempt + 1))

        
    async def _async_get_ai_response(self, prompt):
        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = self.client.models.generate_content(
                    model=self.model,
                    contents=prompt
                )
                text = response.text.strip()
                if text.startswith("```json"):
                    text = text[8:].strip()
                    if text.endswith("```"):
                        text = text[:-3].strip()
                return text
            except Exception as e:
                if attempt == max_retries - 1:
                    return json.dumps({"error": str(e)})
                await asyncio.sleep(1 * (attempt + 1))

    async def calculate_priority(self, financial_context):
        prompt = f"""Analyze this financial context and provide priority assessment:
        
        {json.dumps(financial_context, indent=2, default=str)}
        
        Return JSON with:
        - priority_score (0-100)
        - urgency (days_remaining/total_days)
        - financial_impact (amount/income)
        - health_impact (for students)
        - confidence (0-1)
        - suggested_actions (array)
        - summary (string)


        Note: DO NOT USE ANY MARKDOWN OR HTML. Just return a JSON object.
        """
        response = self._get_ai_response(prompt)
        return self._parse_response(response)
    
    def _parse_response(self, response):
        response = response.strip() or '{"error": "Empty response from AI"}'

        if response.startswith("```json"):
            response = response[8:].strip()
        if response.endswith("```"):
            response = response[:-3].strip()
        try:
            data = json.loads(response)
            if "error" in data:
                return self._fallback_response()
            return data
        except Exception as e:
            traceback.print_exc()
            print(f"Failed to parse AI response: {e}")
            print(f"Response was: {response}")
            return self._fallback_response()
    
    def _fallback_response(self):
        return {
            "priority_score": 50,
            "urgency": 0.5,
            "financial_impact": 0.3,
            "health_impact": 0,
            "confidence": 0,
            "suggested_actions": ["Review manually"]
        }