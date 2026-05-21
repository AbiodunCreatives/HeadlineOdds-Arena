# HeadlineOdds Arena

HeadlineOdds Arena is a Telegram-based prediction game where players compete in real-time arenas, trading BTC price direction rounds with a virtual bankroll funded by real USDC.

## How it works

Each arena has an entry fee paid in USDC. Players join, get a virtual bankroll, and place directional trades (UP or DOWN) on BTC price movement each round. At the end of the arena, the leaderboard determines prize distribution — winnings are credited directly to your in-bot USDC wallet and can be withdrawn to any Solana wallet.

## Getting started

Find the bot on Telegram and use `/start` to open the arena lobby.

## Commands

| Command | Description |
|---|---|
| `/start` | Open the arena lobby |
| `/league` | Browse, create, and manage arenas |
| `/create` | Create a new arena |
| `/join` | Join an arena by code |
| `/live` | View the live round for an arena |
| `/board` | View an arena leaderboard |
| `/status` | View arena details |
| `/wallet` | View your USDC balance and withdraw |
| `/fundngn` | Top up your wallet with Naira via bank transfer |
| `/offrampngn` | Convert USDC to Naira |
| `/withdraw` | Withdraw USDC to a Solana wallet |
| `/chart` | Open the BTC 15-minute chart |
| `/help` | Show all commands |

## Wallet

Each player gets a custodial Solana USDC wallet inside the bot. You can:

- Deposit USDC by sending it to your in-bot wallet address
- Fund with Naira via bank transfer using `/fundngn`
- Withdraw USDC to any external Solana wallet using `/withdraw`
- Offramp USDC to Naira using `/offrampngn`

Deposits are detected on-chain and credited to your balance automatically. Withdrawals are processed from the bot treasury to your specified address.

## Arena rules

- Entry fees are paid in USDC from your in-bot balance
- Each round you place one trade: UP or DOWN on BTC price
- Winning trades return your stake plus profit based on market odds
- Missing rounds reduces your standing
- Prize pool is distributed to top finishers at arena end
- Prizes are credited to your in-bot USDC wallet instantly
