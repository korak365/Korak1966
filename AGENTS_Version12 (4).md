# Global Inventory Heatmap - AI Agent Instructions

Purpose
- Monitor Out-of-Stock (OOS) status across regions for logistics planning.
- Prefer partner/API mode (reliable, permitted). Browser mode is for authorized accounts only.

Do
- Use API mode whenever possible and store tokens securely (KVS).
- In browser mode, only automate accounts you own or have written permission to automate.
- Respect robots.txt and Terms of Service. Implement rate limits and backoff.
- Store credentials in KVS or a secure secret manager; never commit credentials to repo.
- Keep screenshots and raw payload retention policies.

Don't
- Do not attempt to bypass authentication, MFA, or app protections without explicit authorization.
- Do not collect private data you are not permitted to store.
- Do not distribute scraped content in violation of licenses.

Run
- Install dependencies: `npm install`
- Local test: `apify run`
- Deploy: `apify login` then `apify push`