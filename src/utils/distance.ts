export function calculateDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return Number(distance.toFixed(2));
}

export function calculateDuration(distanceInKm: number): number {
  // Assuming average speed of 30 km/h in city traffic
  const averageSpeedKmH = 30;
  const timeInHours = distanceInKm / averageSpeedKmH;
  const timeInMinutes = Math.ceil(timeInHours * 60);

  return timeInMinutes;
}

function toRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}
