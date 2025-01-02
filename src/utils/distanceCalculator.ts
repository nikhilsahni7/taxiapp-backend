import axios from "axios";

interface LatLng {
  lat: number;
  lng: number;
}

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

export const calculateDistance = async (
  pickup: LatLng,
  drop: LatLng
): Promise<number> => {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${pickup.lat},${pickup.lng}&destinations=${drop.lat},${drop.lng}&key=${GOOGLE_MAPS_API_KEY}`
    );

    if (
      !response.data.rows?.[0]?.elements?.[0]?.distance?.value ||
      response.data.status !== "OK"
    ) {
      throw new Error("Invalid response from Google Distance Matrix API");
    }

    const distanceInMeters = response.data.rows[0].elements[0].distance.value;
    return Number((distanceInMeters / 1000).toFixed(2)); // Convert to kilometers with 2 decimal places
  } catch (error) {
    console.error("Error calculating distance:", error);
    // Fallback to haversine formula if API fails
    return calculateHaversineDistance(pickup, drop);
  }
};

export const calculateDuration = async (
  pickup: LatLng,
  drop: LatLng
): Promise<number> => {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${pickup.lat},${pickup.lng}&destinations=${drop.lat},${drop.lng}&key=${GOOGLE_MAPS_API_KEY}`
    );

    if (
      !response.data.rows?.[0]?.elements?.[0]?.duration?.value ||
      response.data.status !== "OK"
    ) {
      throw new Error("Invalid response from Google Distance Matrix API");
    }

    const durationInSeconds = response.data.rows[0].elements[0].duration.value;
    return Math.ceil(durationInSeconds / 60); // Convert to minutes
  } catch (error) {
    console.error("Error calculating duration:", error);
    // Fallback to rough estimation based on distance
    const distance = await calculateDistance(pickup, drop);
    return Math.ceil(distance * 2); // Rough estimate: 30 km/h average speed
  }
};

// Fallback function using Haversine formula for direct distance calculation
function calculateHaversineDistance(pickup: LatLng, drop: LatLng): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRad(drop.lat - pickup.lat);
  const dLon = toRad(drop.lng - pickup.lng);
  const lat1 = toRad(pickup.lat);
  const lat2 = toRad(drop.lat);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(2));
}

function toRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}

// Optional: Function to optimize API calls by caching results
const distanceCache = new Map<string, { distance: number; duration: number }>();

export const getCachedDistanceAndDuration = async (
  pickup: LatLng,
  drop: LatLng
): Promise<{ distance: number; duration: number }> => {
  const cacheKey = `${pickup.lat},${pickup.lng}-${drop.lat},${drop.lng}`;

  if (distanceCache.has(cacheKey)) {
    return distanceCache.get(cacheKey)!;
  }

  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${pickup.lat},${pickup.lng}&destinations=${drop.lat},${drop.lng}&key=${GOOGLE_MAPS_API_KEY}`
    );

    if (response.data.status === "OK") {
      const result = {
        distance: Number(
          (response.data.rows[0].elements[0].distance.value / 1000).toFixed(2)
        ),
        duration: Math.ceil(
          response.data.rows[0].elements[0].duration.value / 60
        ),
      };

      distanceCache.set(cacheKey, result);
      return result;
    }
    throw new Error("Invalid response from Google Distance Matrix API");
  } catch (error) {
    console.error("Error calculating distance and duration:", error);
    const distance = calculateHaversineDistance(pickup, drop);
    const duration = Math.ceil(distance * 2);
    return { distance, duration };
  }
};
