import axios from "axios";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY!;

export const getDistanceAndDuration = async (
  origin: string,
  destination: string
) => {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json`,
      {
        params: {
          origins: origin,
          destinations: destination,
          key: GOOGLE_MAPS_API_KEY,
        },
      }
    );

    const data = response.data;

    // Log the entire response for debugging
    console.log("Google Maps API Response:", JSON.stringify(data, null, 2));

    if (data.status !== "OK") {
      throw new Error(`Google Maps API returned status: ${data.status}`);
    }

    if (data.rows.length === 0 || data.rows[0].elements.length === 0) {
      throw new Error("No valid data in the response from Google Maps API");
    }

    const element = data.rows[0].elements[0];

    if (element.status !== "OK") {
      throw new Error(`Error from Google Maps API: ${element.status}`);
    }

    const distance = element.distance.value / 1000; // Convert meters to kilometers
    const duration = element.duration.value / 60; // Convert seconds to minutes

    return { distance, duration };
  } catch (error: any) {
    console.error("Error fetching distance and duration:", error);
    throw new Error(`Failed to fetch distance and duration: ${error.message}`);
  }
};
