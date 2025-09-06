import aiohttp
import base64
import hashlib
import asyncio
from typing import Optional

class PastebinClient:
    """Minimal async Pastebin client with optional deletion capability.

    Deletion requires user credentials (username/password) so we can obtain
    a user_key. If those aren't provided, delete operations will be skipped.
    """

    def __init__(self, api_key: Optional[str] = None, username: Optional[str] = None, password: Optional[str] = None):
        self.api_key = api_key
        self.username = username
        self.password = password
        self.base_url = "https://pastebin.com/api"
        self._user_key: Optional[str] = None
        self._login_lock = asyncio.Lock()

    async def _ensure_login(self):
        """Obtain user key if credentials provided and not yet logged in."""
        if self._user_key or not (self.api_key and self.username and self.password):
            return
        async with self._login_lock:
            if self._user_key:  # double-checked
                return
            try:
                async with aiohttp.ClientSession() as session:
                    data = {
                        'api_dev_key': self.api_key,
                        'api_user_name': self.username,
                        'api_user_password': self.password
                    }
                    async with session.post(f"{self.base_url}/api_login.php", data=data) as resp:
                        if resp.status == 200:
                            text = await resp.text()
                            if not text.startswith('Bad API request'):
                                self._user_key = text.strip()
            except Exception:
                # Silent failure; deletion will just be disabled
                pass

    async def create_paste(self, title, content, private: bool = True):
        if not self.api_key:
            return None
        try:
            # Simple content scrambling (NOT encryption)
            scrambled = base64.b64encode(
                hashlib.sha256(content.encode()).digest()[:20] + content.encode()
            ).decode()

            async with aiohttp.ClientSession() as session:
                params = {
                    'api_dev_key': self.api_key,
                    'api_option': 'paste',
                    'api_paste_code': scrambled,
                    'api_paste_name': title,
                    'api_paste_private': 1 if private else 0,
                    'api_paste_expire_date': '1M'
                }
                async with session.post(f"{self.base_url}/api_post.php", data=params) as resp:
                    if resp.status == 200:
                        text = await resp.text()
                        if text.startswith('http'):
                            return text.strip()  # full URL
                    return None
        except Exception:
            return None

    async def read_paste(self, paste_id):
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"https://pastebin.com/raw/{paste_id}") as resp:
                    if resp.status == 200:
                        content = await resp.text()
                        decoded = base64.b64decode(content.encode())
                        return decoded[20:].decode()
                    return None
        except Exception:
            return None

    async def delete_paste(self, paste_key: str) -> bool:
        """Attempt to delete a paste. Returns True if deletion succeeded.
        Requires user credentials (user_key). If not available, returns False.
        """
        if not self.api_key:
            return False
        await self._ensure_login()
        if not self._user_key:
            return False
        try:
            async with aiohttp.ClientSession() as session:
                data = {
                    'api_dev_key': self.api_key,
                    'api_user_key': self._user_key,
                    'api_option': 'delete',
                    'api_paste_key': paste_key
                }
                async with session.post(f"{self.base_url}/api_post.php", data=data) as resp:
                    if resp.status == 200:
                        text = await resp.text()
                        return text.strip() == 'Paste Removed'
        except Exception:
            return False
        return False

    @staticmethod
    def extract_paste_key(paste_url: str) -> Optional[str]:
        if not paste_url:
            return None
        return paste_url.rstrip('/').split('/')[-1]