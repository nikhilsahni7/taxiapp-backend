import { PrismaClient } from "@prisma/client";
import axios from "axios";

const prisma = new PrismaClient();
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY!;

/**
 * Searches for available drivers within a given radius.
 */
export const searchAvailableDrivers = async (
  pickupLocation: string,
  radius: number
) => {
  const { lat, lng } = await geocodeAddress(pickupLocation);

  // Find drivers within the radius
  const drivers = await prisma.driverStatus.findMany({
    where: {
      isOnline: true,
      locationLat: {
        gte: lat - radius / 111,
        lte: lat + radius / 111,
      },
      locationLng: {
        gte: lng - radius / (111 * Math.cos((lat * Math.PI) / 180)),
        lte: lng + radius / (111 * Math.cos((lat * Math.PI) / 180)),
      },
    },
    include: {
      driver: true,
    },
  });
  return drivers;
};

/**
 * Geocodes an address to get latitude and longitude.
 */
const geocodeAddress = async (
  address: string
): Promise<{ lat: number; lng: number }> => {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        address
      )}&key=${GOOGLE_MAPS_API_KEY}`
    );
    const location = response.data.results[0].geometry.location;
    return { lat: location.lat, lng: location.lng };
  } catch (error) {
    console.error("Error geocoding address:", error);
    return { lat: 0, lng: 0 };
  }
};
