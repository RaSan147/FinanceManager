import aiohttp
import base64
import hashlib

class PastebinClient:
    def __init__(self, api_key=None):
        self.api_key = api_key
        self.base_url = "https://pastebin.com/api"

    async def create_paste(self, title, content, private=True):
        if not self.api_key:
            return None
            
        try:
            # Simple content scrambling
            scrambled = base64.b64encode(
                hashlib.sha256(content.encode()).digest()[:20] + 
                content.encode()
            ).decode()
            
            async with aiohttp.ClientSession() as session:
                params = {
                    'api_dev_key': self.api_key,
                    'api_option': 'paste',
                    'api_paste_code': scrambled,
                    'api_paste_name': title,
                    'api_paste_private': 1 if private else 0,
                    'api_paste_expire_date': '1M'  # 1 month
                }
                async with session.post(f"{self.base_url}/api_post.php", data=params) as resp:
                    if resp.status == 200:
                        return await resp.text()
                    return None
        except Exception:
            return None

    async def read_paste(self, paste_id):
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"https://pastebin.com/raw/{paste_id}") as resp:
                    if resp.status == 200:
                        content = await resp.text()
                        # Descramble content
                        decoded = base64.b64decode(content.encode())
                        return decoded[20:].decode()
                    return None
        except Exception:
            return None