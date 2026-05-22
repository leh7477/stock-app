export default async function handler(req, res) {
  const r = await fetch('https://api.ipify.org?format=json');
  const data = await r.json();
  res.status(200).json({ ip: data.ip });
}
