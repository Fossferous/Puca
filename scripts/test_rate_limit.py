
import asyncio
import aiohttp
import time

async def main():
    url = "http://127.0.0.1:3000/auth/login/step1"
    payload = {"username": "testuser"}
    
    async with aiohttp.ClientSession() as session:
        tasks = []
        for i in range(20):
            tasks.append(fetch(session, url, payload, i))
        
        results = await asyncio.gather(*tasks)
        
        status_codes = [r for r in results]
        print(f"Status codes: {status_codes}")
        
        success_count = status_codes.count(200) + status_codes.count(400) + status_codes.count(401) + status_codes.count(404) # Any normal response
        rate_limited_count = status_codes.count(429)
        
        print(f"Normal responses: {success_count}")
        print(f"Rate limited responses: {rate_limited_count}")
        
        if rate_limited_count > 0:
            print("SUCCESS: Rate limiting is working.")
        else:
            print("FAILURE: No rate limiting observed.")

async def fetch(session, url, payload, index):
    try:
        async with session.post(url, json=payload) as response:
            # print(f"Request {index}: {response.status}")
            return response.status
    except Exception as e:
        print(f"Request {index} failed: {e}")
        return 0

if __name__ == "__main__":
    asyncio.run(main())
