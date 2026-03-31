import { getConfig } from '../config.js';

const suspiciousPhrases = ['seo', 'backlink', 'casino', 'crypto', 'forex', 'telegram', 'whatsapp', 'loan'];
const urlPattern = /(https?:\/\/|www\.)/gi;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function countMatches(pattern, value) {
  const matches = value.match(pattern);
  return matches ? matches.length : 0;
}

export function evaluateSubmissionSpam(payload) {
  const config = getConfig();
  const reasons = [];
  let score = 0;
  let hardBlock = false;
  const message = payload.message.toLowerCase();

  if (payload.website) {
    reasons.push('Honeypot field was filled.');
    score += 100;
    hardBlock = true;
  }

  if (payload.elapsedMs < config.protection.minSubmitTimeMs) {
    reasons.push('Form was submitted too quickly.');
    score += 35;
  }

  const urlCount = countMatches(urlPattern, payload.message);

  if (urlCount > 2) {
    reasons.push('Message contains too many links.');
    score += 25;
  }

  const emailCount = countMatches(emailPattern, payload.message);

  if (emailCount > 2) {
    reasons.push('Message contains too many email addresses.');
    score += 15;
  }

  suspiciousPhrases.forEach((phrase) => {
    if (message.includes(phrase)) {
      reasons.push(`Message contains suspicious phrase: ${phrase}`);
      score += 15;
    }
  });

  if (payload.message.length < 12) {
    reasons.push('Message is unusually short.');
    score += 10;
  }

  return {
    hardBlock,
    reasons,
    score,
    isSpam: score >= config.protection.spamScoreThreshold,
  };
}
