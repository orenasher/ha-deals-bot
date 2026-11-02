# Deals Bot – Home Assistant add-on

A private Telegram bot that turns an AliExpress affiliate link and a product photo into a Hebrew post (written by Claude), and publishes it to a Telegram channel, WhatsApp groups and a Facebook Page.

## Install

1. Home Assistant → Settings → Add-ons → Add-on Store → ⋮ → Repositories.
2. Add `https://github.com/orenasher/ha-deals-bot`.
3. Install **Deals Bot**, fill in the Configuration tab and start it.

Full instructions (Hebrew) are in the add-on's Documentation tab ([DOCS.md](deals_bot/DOCS.md)).

## Notes

- WhatsApp uses [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web protocol) with a separate, linked number. It is not an official WhatsApp API.
- Facebook: Page posting through the Graph API. Groups have had no posting API since April 2024.
- AliExpress: works with links from Portals; with Affiliate API keys it also reads product details and creates links itself.
