import axios from "axios";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

interface DistanceMatrixResponse {
  distance: number; // in kilometers
  duration: number; // in minutes
}

export async function getDistanceMatrix(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<DistanceMatrixResponse> {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originLat},${originLng}&destinations=${destLat},${destLng}&mode=driving&key=${GOOGLE_MAPS_API_KEY}`
    );

    const result = response.data.rows[0].elements[0];

    return {
      distance: result.distance.value / 1000, // Convert meters to kilometers
      duration: Math.ceil(result.duration.value / 60), // Convert seconds to minutes
    };
  } catch (error) {
    console.error("Error getting distance matrix:", error);
    throw error;
  }
}
