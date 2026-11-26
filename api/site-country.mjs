// Vercel sets this country header. We return only a supported language hint,
// never the IP address, country, coordinates, or a cacheable response.
const countries = {
  DE: 'de', AT: 'de', LI: 'de', FR: 'fr', MC: 'fr', IT: 'it', SM: 'it', VA: 'it',
  JP: 'ja', KR: 'ko', RU: 'ru', CN: 'zh-Hans', TW: 'zh-Hant', HK: 'zh-Hant', MO: 'zh-Hant',
  AR: 'es', BO: 'es', CL: 'es', CO: 'es', CR: 'es', CU: 'es', DO: 'es', EC: 'es', ES: 'es',
  GT: 'es', HN: 'es', MX: 'es', NI: 'es', PA: 'es', PE: 'es', PR: 'es', PY: 'es',
  SV: 'es', UY: 'es', VE: 'es', GQ: 'es',
};

export function languageForCountry(country) {
  return typeof country === 'string' && Object.hasOwn(countries, country) ? countries[country] : null;
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).end();
    return;
  }
  res.status(200).json({ locale: languageForCountry(req.headers['x-vercel-ip-country']) });
}
