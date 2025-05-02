import { PrismaClient } from "@prisma/client";
import axios from "axios";

const prisma = new PrismaClient();
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY!;

// Helper function to calculate distance using Google Maps API
const calculateDistance = async (
  origin: string,
  destination: string
): Promise<number> => {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(
        origin
      )}&destinations=${encodeURIComponent(
        destination
      )}&key=${GOOGLE_MAPS_API_KEY}`
    );
    const distanceInMeters = response.data.rows[0].elements[0].distance.value;
    return distanceInMeters / 1000; // Convert to kilometers
  } catch (error) {
    console.error("Error calculating distance:", error);
    return 0;
  }
};

export const geocodeAddress = async (
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
    throw new Error("Failed to geocode address");
  }
};

export const searchAvailableDrivers = async (
  pickupLocation: string,
  radius: number,
  filterOptions?: {
    hasCarrier?: boolean;
    carCategory?: string;
  }
) => {
  const { lat, lng } = await geocodeAddress(pickupLocation);

  // Find online drivers within the radius, including details needed for filtering
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
      driver: {
        ridesAsDriver: {
          none: {
            status: {
              in: ["ACCEPTED", "DRIVER_ARRIVED", "RIDE_STARTED"],
            },
          },
        },
        // Only filter by carrier in the DB query if specified
        ...(filterOptions?.hasCarrier && {
          driverDetails: {
            hasCarrier: true,
          },
        }),
      },
      // We will filter by carCategory in the application code below
    },
    include: {
      driver: {
        // Ensure driverDetails is included to access vehicleCategory
        include: {
          driverDetails: true,
        },
      },
    },
    orderBy: [
      { locationLat: "asc" },
      { locationLng: "asc" },
    ],
  });

  console.log(
    `[searchAvailableDrivers] Found ${drivers.length} drivers within ${radius}km before category filter.`
  );

  // In-code filtering based on carCategory
  const categoryFilteredDrivers = filterOptions?.carCategory
    ? drivers.filter((driverStatus) => {
        const driverCategory = driverStatus.driver?.driverDetails?.vehicleCategory?.toLowerCase();
        const requestedCategory = filterOptions.carCategory!.toLowerCase();
        // Check if driver has details and their category matches the request
        return driverCategory === requestedCategory;
      })
    : drivers; // If no category filter, use all found drivers

  console.log(
    `[searchAvailableDrivers] Found ${categoryFilteredDrivers.length} drivers after category filter (${filterOptions?.carCategory || "none"}).`
  );

  // Calculate exact distance for the filtered drivers
  const driversWithDistance = await Promise.all(
    categoryFilteredDrivers.map(async (driver) => { // Use categoryFilteredDrivers here
      const distance = await calculateDistance(
        `${driver.locationLat},${driver.locationLng}`,
        pickupLocation
      );
      return { ...driver, distance };
    })
  );

  // Sort by actual distance
  return driversWithDistance.sort((a, b) => a.distance - b.distance);
};
