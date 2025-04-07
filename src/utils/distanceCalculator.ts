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
    // First attempt: Try with Google Distance Matrix API
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${pickup.lat},${pickup.lng}&destinations=${drop.lat},${drop.lng}&key=${GOOGLE_MAPS_API_KEY}`
    );

    if (
      response.data.status === "OK" &&
      response.data.rows?.[0]?.elements?.[0]?.status === "OK"
    ) {
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

    // Second attempt: Try with alternative API endpoint
    try {
      const altResponse = await axios.get(
        `https://maps.googleapis.com/maps/api/directions/json?origin=${pickup.lat},${pickup.lng}&destination=${drop.lat},${drop.lng}&key=${GOOGLE_MAPS_API_KEY}`
      );

      if (altResponse.data.status === "OK" && altResponse.data.routes?.[0]) {
        const route = altResponse.data.routes[0];
        const distance = Number(
          (route.legs[0].distance.value / 1000).toFixed(2)
        );
        const duration = Math.ceil(route.legs[0].duration.value / 60);
        const result = { distance, duration };
        distanceCache.set(cacheKey, result);
        return result;
      }
    } catch (altError) {
      console.warn("Alternative API attempt failed:", altError);
    }

    // Final fallback: Use haversine with adjusted factors for hilly terrain
    const haversineDistance = calculateHaversineDistance(pickup, drop);
    const isHillyTerrain = isHillyRegion(pickup) || isHillyRegion(drop);

    // Adjust distance and duration for hilly terrain
    const adjustedDistance = isHillyTerrain
      ? haversineDistance * 1.3
      : haversineDistance;
    const adjustedDuration = isHillyTerrain
      ? Math.ceil(adjustedDistance * 2.5) // More time for hilly terrain
      : Math.ceil(adjustedDistance * 2); // Standard time for flat terrain

    const result = {
      distance: Number(adjustedDistance.toFixed(2)),
      duration: adjustedDuration,
    };
    distanceCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error("Error calculating distance and duration:", error);

    // Fallback to haversine with terrain adjustment
    const haversineDistance = calculateHaversineDistance(pickup, drop);
    const isHillyTerrain = isHillyRegion(pickup) || isHillyRegion(drop);

    const adjustedDistance = isHillyTerrain
      ? haversineDistance * 1.3
      : haversineDistance;
    const adjustedDuration = isHillyTerrain
      ? Math.ceil(adjustedDistance * 2.5)
      : Math.ceil(adjustedDistance * 2);

    const result = {
      distance: Number(adjustedDistance.toFixed(2)),
      duration: adjustedDuration,
    };
    distanceCache.set(cacheKey, result);
    return result;
  }
};

// Helper function to check if a location is in a hilly region
function isHillyRegion(location: LatLng): boolean {
  // Define approximate boundaries of hilly regions in India
  const hillyRegions = [
    // Uttarakhand region
    { minLat: 28.5, maxLat: 31.5, minLng: 77.5, maxLng: 80.5 },
    // Himachal Pradesh region
    { minLat: 30.5, maxLat: 33.5, minLng: 75.5, maxLng: 78.5 },
    // Jammu & Kashmir region
    { minLat: 32.5, maxLat: 35.5, minLng: 73.5, maxLng: 76.5 },
    // North Eastern states
    { minLat: 22.0, maxLat: 28.0, minLng: 89.0, maxLng: 97.0 },
  ];

  return hillyRegions.some(
    (region) =>
      location.lat >= region.minLat &&
      location.lat <= region.maxLat &&
      location.lng >= region.minLng &&
      location.lng <= region.maxLng
  );
}
