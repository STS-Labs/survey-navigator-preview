// The survey days that have been reviewed and cleaned (Tbilisi-Parking-Study, Parking_Routing/plan_clean),
// bundled unchanged; days are added here one by one as they are cleaned.
export const SURVEY_DAYS = [
  { number: 1, file: 'data/routes/clean_day_01.gpx' },
  { number: 2, file: 'data/routes/clean_day_02.gpx' },
  { number: 3, file: 'data/routes/clean_day_03.gpx' },
  { number: 4, file: 'data/routes/clean_day_04.gpx' },
  { number: 5, file: 'data/routes/clean_day_05.gpx' },
  { number: 6, file: 'data/routes/clean_day_06.gpx' },
  { number: 7, file: 'data/routes/clean_day_07.gpx' },
  { number: 8, file: 'data/routes/clean_day_08.gpx' },
  { number: 9, file: 'data/routes/clean_day_09.gpx' },
  { number: 10, file: 'data/routes/clean_day_10.gpx' },
  // the extra days (12 Nov 2026): the 734 City Hall lots still to film, from the STS office
  { number: 11, file: 'data/routes/clean_day_11.gpx' },
  { number: 12, file: 'data/routes/clean_day_12.gpx' },
  { number: 13, file: 'data/routes/clean_day_13.gpx' },
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
