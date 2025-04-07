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

  // Log the request coordinates for debugging
  console.log(
    `Distance calculation request for: ${JSON.stringify({ pickup, drop })}`
  );

  try {
    // First attempt: Try with Google Distance Matrix API
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${pickup.lat},${pickup.lng}&destinations=${drop.lat},${drop.lng}&key=${GOOGLE_MAPS_API_KEY}`
    );

    // Log the Google API response for debugging
    console.log(
      `Google Distance Matrix API response status: ${response.data.status}`
    );
    if (
      response.data.rows &&
      response.data.rows[0] &&
      response.data.rows[0].elements &&
      response.data.rows[0].elements[0]
    ) {
      console.log(
        `Element status: ${response.data.rows[0].elements[0].status}`
      );
    }

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

      console.log(
        `Google API success - distance: ${result.distance}km, duration: ${result.duration}min`
      );
      distanceCache.set(cacheKey, result);
      return result;
    }

    // Second attempt: Try with alternative API endpoint
    try {
      console.log("First API attempt failed, trying Directions API...");
      const altResponse = await axios.get(
        `https://maps.googleapis.com/maps/api/directions/json?origin=${pickup.lat},${pickup.lng}&destination=${drop.lat},${drop.lng}&key=${GOOGLE_MAPS_API_KEY}`
      );

      console.log(
        `Google Directions API response status: ${altResponse.data.status}`
      );

      if (altResponse.data.status === "OK" && altResponse.data.routes?.[0]) {
        const route = altResponse.data.routes[0];
        const distance = Number(
          (route.legs[0].distance.value / 1000).toFixed(2)
        );
        const duration = Math.ceil(route.legs[0].duration.value / 60);
        const result = { distance, duration };
        console.log(
          `Directions API success - distance: ${result.distance}km, duration: ${result.duration}min`
        );
        distanceCache.set(cacheKey, result);
        return result;
      }
    } catch (altError) {
      console.warn("Alternative API attempt failed:", altError);
    }

    // Check for specific mountain route pairs
    const specificRouteResult = getSpecificMountainRoute(pickup, drop);
    if (specificRouteResult) {
      console.log(
        `Using specific mountain route data: ${JSON.stringify(specificRouteResult)}`
      );
      distanceCache.set(cacheKey, specificRouteResult);
      return specificRouteResult;
    }

    // Final fallback: Use haversine with adjusted factors for hilly terrain
    const haversineDistance = calculateHaversineDistance(pickup, drop);
    const isHillyTerrain = isHillyRegion(pickup, drop);

    // Enhanced distance adjustment based on terrain
    let adjustedDistance = haversineDistance;
    let adjustedDuration = 0;

    if (isHillyTerrain === "high_mountains") {
      // High mountain regions need more significant adjustments
      adjustedDistance = haversineDistance * 1.5; // 50% longer due to winding roads
      adjustedDuration = Math.ceil(adjustedDistance * 3); // Much slower in high mountains
    } else if (isHillyTerrain === "hilly") {
      // Normal hilly regions
      adjustedDistance = haversineDistance * 1.3;
      adjustedDuration = Math.ceil(adjustedDistance * 2.5);
    } else {
      // Flat terrain
      adjustedDistance = haversineDistance;
      adjustedDuration = Math.ceil(adjustedDistance * 2);
    }

    const result = {
      distance: Number(adjustedDistance.toFixed(2)),
      duration: adjustedDuration,
    };

    console.log(
      `Using adjusted haversine - terrain type: ${isHillyTerrain}, distance: ${result.distance}km, duration: ${result.duration}min`
    );
    distanceCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error("Error calculating distance and duration:", error);

    // Check for specific mountain route pairs even in error case
    const specificRouteResult = getSpecificMountainRoute(pickup, drop);
    if (specificRouteResult) {
      console.log(
        `Using specific mountain route data after error: ${JSON.stringify(specificRouteResult)}`
      );
      distanceCache.set(cacheKey, specificRouteResult);
      return specificRouteResult;
    }

    // Fallback to haversine with terrain adjustment
    const haversineDistance = calculateHaversineDistance(pickup, drop);
    const isHillyTerrain = isHillyRegion(pickup, drop);

    // Enhanced distance adjustment based on terrain
    let adjustedDistance = haversineDistance;
    let adjustedDuration = 0;

    if (isHillyTerrain === "high_mountains") {
      adjustedDistance = haversineDistance * 1.5;
      adjustedDuration = Math.ceil(adjustedDistance * 3);
    } else if (isHillyTerrain === "hilly") {
      adjustedDistance = haversineDistance * 1.3;
      adjustedDuration = Math.ceil(adjustedDistance * 2.5);
    } else {
      adjustedDistance = haversineDistance;
      adjustedDuration = Math.ceil(adjustedDistance * 2);
    }

    const result = {
      distance: Number(adjustedDistance.toFixed(2)),
      duration: adjustedDuration,
    };

    console.log(
      `Using adjusted haversine after error - terrain type: ${isHillyTerrain}, distance: ${result.distance}km, duration: ${result.duration}min`
    );
    distanceCache.set(cacheKey, result);
    return result;
  }
};

// Enhanced function to detect mountain regions with more granularity
function isHillyRegion(
  pickup: LatLng,
  drop: LatLng
): "flat" | "hilly" | "high_mountains" {
  // Define specific high mountain regions
  const highMountainRegions = [
    // Nainital and surrounding areas
    { minLat: 29.1, maxLat: 29.5, minLng: 79.2, maxLng: 79.7 },
    // Mussoorie and surrounding areas
    { minLat: 30.3, maxLat: 30.6, minLng: 77.9, maxLng: 78.2 },
    // Shimla region
    { minLat: 30.9, maxLat: 31.2, minLng: 77.0, maxLng: 77.4 },
    // Darjeeling region
    { minLat: 26.9, maxLat: 27.2, minLng: 88.1, maxLng: 88.4 },
  ];

  // Define general hilly regions
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

  // Check if either pickup or drop is in a high mountain region
  const isHighMountain = [pickup, drop].some((loc) =>
    highMountainRegions.some(
      (region) =>
        loc.lat >= region.minLat &&
        loc.lat <= region.maxLat &&
        loc.lng >= region.minLng &&
        loc.lng <= region.maxLng
    )
  );

  if (isHighMountain) {
    return "high_mountains";
  }

  // Check if either pickup or drop is in a hilly region
  const isHilly = [pickup, drop].some((loc) =>
    hillyRegions.some(
      (region) =>
        loc.lat >= region.minLat &&
        loc.lat <= region.maxLat &&
        loc.lng >= region.minLng &&
        loc.lng <= region.maxLng
    )
  );

  return isHilly ? "hilly" : "flat";
}

// Function to handle specific mountain routes that need exact values
function getSpecificMountainRoute(
  pickup: LatLng,
  drop: LatLng
): { distance: number; duration: number } | null {
  // Define specific problematic mountain routes with exact distances and durations
  const specificRoutes = [
    // Haldwani to Nainital
    {
      pickup: { lat: 29.2208, lng: 79.5286, radius: 0.1 }, // Haldwani
      drop: { lat: 29.3919, lng: 79.4542, radius: 0.1 }, // Nainital
      distance: 35,
      duration: 90,
    },
    // Dehradun to Mussoorie
    {
      pickup: { lat: 30.3165, lng: 78.0322, radius: 0.1 }, // Dehradun
      drop: { lat: 30.4598, lng: 78.064, radius: 0.1 }, // Mussoorie
      distance: 35,
      duration: 90,
    },
    // Can add more specific routes here as needed
  ];

  // Check if the route matches any specific route (in either direction)
  for (const route of specificRoutes) {
    if (
      (isPointInRadius(pickup, route.pickup, route.pickup.radius) &&
        isPointInRadius(drop, route.drop, route.drop.radius)) ||
      (isPointInRadius(pickup, route.drop, route.drop.radius) &&
        isPointInRadius(drop, route.pickup, route.pickup.radius))
    ) {
      return {
        distance: route.distance,
        duration: route.duration,
      };
    }
  }

  return null;
}

// Helper function to check if a point is within a radius of another point
function isPointInRadius(
  point: LatLng,
  center: LatLng & { radius: number },
  radiusOverride?: number
): boolean {
  const radius = radiusOverride || center.radius;
  const latDiff = Math.abs(point.lat - center.lat);
  const lngDiff = Math.abs(point.lng - center.lng);
  return latDiff <= radius && lngDiff <= radius;
}
