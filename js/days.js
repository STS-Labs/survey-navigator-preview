// The survey days that have been reviewed and cleaned (Tbilisi-Parking-Study, Parking_Routing/plan_clean),
// bundled unchanged; days are added here one by one as they are cleaned.
export const SURVEY_DAYS = [
  { number: 1, file: 'data/routes/clean_day_01.gpx' },
];

export async function loadSurveyDay(number) {
  const entry = SURVEY_DAYS.find((day) => day.number === number);
  if (!entry) throw new Error('unknown-day');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(entry.file, { signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}
