import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';

dotenv.config();

const app = express();

// Initialize Upstash Redis with correct env variable names
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const KNOWN_TOKENS = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD',
  '38wQFRuj6FezzGYegzHdqrRK7hkEkBx7wSqxDBYXpKpy': 'kPUSD-USDC'
};

app.use(express.json());

// Decode and format the webhook event
function decodeWebhookEvent(event) {
  const signature = event.signature;
  const timestamp = new Date(event.timestamp * 1000).toISOString();
  const type = event.type || 'UNKNOWN';
  const source = event.source || 'Unknown';
  
  const tokenTransfers = event.tokenTransfers || [];
  let withdrawal = null;
  
  if (tokenTransfers.length > 0) {
    const transfer = tokenTransfers[0];
    const tokenSymbol = KNOWN_TOKENS[transfer.mint] || `${transfer.mint.slice(0, 8)}...`;
    const amount = transfer.tokenAmount;
    
    withdrawal = {
      from: transfer.fromUserAccount,
      to: transfer.toUserAccount,
      token: tokenSymbol,
      amount: amount,
      mint: transfer.mint
    };
  }
  
  return {
    signature,
    timestamp,
    type,
    source,
    withdrawal,
    fee: event.fee / 1e9,
  };
}

// Format message for Telegram
function formatTelegramMessage(decoded) {
  let message = `🔔 <b>New Withdrawal Detected</b>\n\n`;
  
  if (decoded.withdrawal) {
    message += `<b>Token Transfer:</b>\n\n`;
    message += `<b>${decoded.withdrawal.token}</b>\n`;
    message += `Amount: ${decoded.withdrawal.amount}\n`;
    message += `From: <code>${decoded.withdrawal.from}</code>\n`;
    message += `To: <code>${decoded.withdrawal.to}</code>\n`;
  }
  
  message += `\n🔗 <b>Transaction:</b>\n<code>${decoded.signature}</code>\n`;
  message += `\n<a href="https://solscan.io/tx/${decoded.signature}">View on Solscan</a>`;
  
  return message;
}

// Send message to Telegram
async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });

    const result = await response.json();
    
    if (result.ok) {
      console.log('✅ Message sent to Telegram successfully');
    } else {
      console.error('❌ Failed to send to Telegram:', result.description);
    }
    
    return result;
  } catch (error) {
    console.error('❌ Error sending to Telegram:', error.message);
    return null;
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/webhook', async (req, res) => {
  console.log('📨 Webhook received from Helius');
  const payload = req.body;
  
  // Handle array of events
  const events = Array.isArray(payload) ? payload : [payload];
  
  for (const event of events) {
    const signature = event.signature;
    
    try {
      // Check if transaction already processed using Upstash Redis
      const cacheKey = `tx:${signature}`;
      const exists = await redis.get(cacheKey);
      
      if (exists) {
        console.log(`⏭️ Duplicate transaction detected, skipping: ${signature.slice(0, 16)}...`);
        continue;
      }
      
      // Filter for transactions containing "withdraw" in the type or description
      const type = (event.type || '').toLowerCase();
      const description = (event.description || '').toLowerCase();
      
      if (type.includes('withdraw') || description.includes('withdraw')) {
        console.log('💸 Withdrawal detected!');
        
        // Mark transaction as processed with 15 minute TTL (900 seconds)
        await redis.set(cacheKey, '1', { ex: 900 });
        
        // Decode the event
        const decoded = decodeWebhookEvent(event);
        
        // Format message
        const message = formatTelegramMessage(decoded);
        
        // Send to Telegram
        await sendTelegramMessage(message);
      } else {
        console.log(new Date().toISOString());
        console.log(`⏭️ Skipping event type: ${type}`);
        
        // Still cache non-withdrawal transactions to prevent re-processing
        await redis.set(cacheKey, '1', { ex: 900 });
      }
    } catch (error) {
      console.error('❌ Error processing transaction:', error);
    }
  }
  
  // Respond AFTER all processing is complete (critical for Vercel)
  res.status(200).json({ received: true });
});

// For local development
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Webhook receiver listening on port ${PORT}`);
    console.log(`📱 Telegram Bot Token: ${TELEGRAM_BOT_TOKEN ? '✅ Set' : '❌ Not set'}`);
    console.log(`💬 Telegram Chat ID: ${TELEGRAM_CHAT_ID ? '✅ Set' : '❌ Not set'}`);
    console.log(`🔴 Redis URL: ${process.env.KV_REST_API_URL ? '✅ Set' : '❌ Not set'}`);
  });
}

// Export for Vercel serverless
export default app;