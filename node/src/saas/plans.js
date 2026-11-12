const featureSet = (allowed, alertDelay) => Object.fromEntries(['evaluate', 'proposal', 'estimate', 'prototype', 'radar'].map((name) => [name, allowed.includes(name)])
  .concat(allowed.includes('sound_notifications') ? [['sound_notifications', true]] : [], [['alert_delay_minutes', alertDelay]]));
export function planSeeds(config = {}) {
  const nums = config.PLAN_SEEDS || { free: { monthly_points: 15, daily_points_cap: 10 }, pro: { monthly_points: 150, daily_points_cap: 40 }, power: { monthly_points: 600, daily_points_cap: 120 } };
  return [
    { id: 'owner', name: 'Owner', monthly_points: -1, daily_points_cap: null, features: featureSet(['evaluate','proposal','estimate','prototype','radar'], 0), price_egp: 0, price_usd: 0 },
    { id: 'free', name: 'Free', ...nums.free, features: featureSet(['evaluate','estimate'], 45), price_egp: 0, price_usd: 0 },
    { id: 'pro', name: 'Pro', ...nums.pro, features: featureSet(['evaluate','proposal','estimate','prototype','radar','sound_notifications'], 0), price_egp: 0, price_usd: 0 },
    { id: 'power', name: 'Power', ...nums.power, features: featureSet(['evaluate','proposal','estimate','prototype','radar','sound_notifications'], 0), price_egp: 0, price_usd: 0 },
  ];
}
export function listPlans(db) { return db.prepare('SELECT id,name,monthly_points,daily_points_cap,features,price_egp,price_usd FROM plans ORDER BY CASE id WHEN \'owner\' THEN 0 WHEN \'free\' THEN 1 WHEN \'pro\' THEN 2 ELSE 3 END').all().map((p) => ({ ...p, features: JSON.parse(p.features) })); }
