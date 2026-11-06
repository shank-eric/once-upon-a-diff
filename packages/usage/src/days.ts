/* Days and times for the usage files and the report: Eastern Time, as Eric reads them. */

const DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** The ET calendar day of a time, as YYYY-MM-DD. */
export const etDay = (when: Date | string | number): string => DAY.format(new Date(when));

/** "11/4, 9:12 PM ET" for an ISO time. */
export const etClock = (iso: string): string => `${CLOCK.format(new Date(iso))} ET`;

/** "14 h" or "3 d 4 h" or "20 min" for a span in ms. */
export function spanText(millis: number): string {
  const minutes = Math.max(0, Math.round(millis / 60000));
  if (minutes < 90) {
    return `${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
