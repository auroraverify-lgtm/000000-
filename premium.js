export const PREMIUM_EMOJI = [
  { id: 'yabloko-golub', code: 'yabloko-golub' },
  { id: 'yabloko-logo', code: 'yabloko-logo' },
  { id: 'yabloko-text', code: 'yabloko-text' },
  { id: 'yabloko-pin', code: 'yabloko-pin' },
  { id: 'yabloko-clip', code: 'yabloko-clip' },
  { id: 'yabloko-bolt', code: 'yabloko-bolt' },
  { id: 'aurora-emoji-nova', code: 'aurora-nova' },
  { id: 'aurora-emoji-heart', code: 'aurora-heart' },
  { id: 'aurora-emoji-comet', code: 'aurora-comet' },
  { id: 'aurora-emoji-flame', code: 'aurora-flame' },
  { id: 'aurora-emoji-crown', code: 'aurora-crown' },
  { id: 'premium-news-megafon', code: 'premium-news-megafon' },
  { id: 'premium-news-paper', code: 'premium-news-paper' },
  { id: 'premium-news-rocket', code: 'premium-news-rocket' },
  { id: 'premium-news-star', code: 'premium-news-star' },
  { id: 'premium-news-alert', code: 'premium-news-alert' },
  { id: 'premium-news-aurora', code: 'premium-news-aurora' },
  { id: 'premium-news-bell', code: 'premium-news-bell' },
  { id: 'premium-news-calendar', code: 'premium-news-calendar' },
  { id: 'premium-news-check', code: 'premium-news-check' },
  { id: 'premium-news-info', code: 'premium-news-info' },
];

export const PREMIUM_EMOJI_IDS = PREMIUM_EMOJI.map(({ id }) => id);
export const PREMIUM_EMOJI_CODES = PREMIUM_EMOJI.map(({ code }) => code);
export const PREMIUM_REACTION_IDS = PREMIUM_EMOJI_IDS;

export function sanitizePremiumEmojiText(text, isPremium) {
  const value = String(text ?? '');
  if (isPremium) return value;
  const tokens = new Set(PREMIUM_EMOJI_CODES);
  return value.replace(/:([a-z0-9-]{3,32}):/gi, (token, code) => (
    tokens.has(code.toLowerCase()) ? '' : token
  ));
}
