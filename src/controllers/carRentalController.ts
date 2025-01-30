import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { io } from "../server";
import { CarRentalSocketHandler } from "../socket/carRentalHandler";
import { searchAvailableDrivers } from "../lib/driverService";
import { calculateDistance, calculateDuration } from "../utils/distance";
import { getDistanceMatrix } from "../utils/googleMaps";

const prisma = new PrismaClient();

export class CarRentalController {
  // Create new booking
  async createBooking(req: Request, res: Response) {
    try {
      console.log("Creating new car rental booking...");
      const { packageId, pickupLocation, pickupLat, pickupLng, paymentMode } =
        req.body;

      const userId = req.user?.userId;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      // Get package details and nearby drivers in parallel
      const [carRentalPackage, nearbyDrivers] = await Promise.all([
        prisma.carRentalPackage.findUnique({
          where: { id: packageId },
        }),
        searchAvailableDrivers(`${pickupLat},${pickupLng}`, 10),
      ]);

      if (!carRentalPackage) {
        return res.status(404).json({ error: "Package not found" });
      }

      // Get closest driver's distance and duration using Google Maps
      let pickupDistance = 0;
      let pickupDuration = 0;

      if (nearbyDrivers.length > 0) {
        const closestDriver = nearbyDrivers[0];
        const { distance, duration } = await getDistanceMatrix(
          closestDriver.locationLat!,
          closestDriver.locationLng!,
          pickupLat,
          pickupLng
        );
        pickupDistance = distance;
        pickupDuration = duration;
      }

      // Create booking
      const booking = await prisma.carRentalBooking.create({
        data: {
          packageId,
          userId,
          pickupLocation,
          pickupLat,
          pickupLng,
          pickupDistance,
          pickupDuration,
          hours: carRentalPackage.hours,
          kilometers: carRentalPackage.kilometers,
          carType: carRentalPackage.carType,
          baseAmount: carRentalPackage.basePrice,
          paymentMode,
        },
        include: {
          package: true,
          user: true,
        },
      });

      console.log("Booking created:", booking);

      // Use the socket handler
      const socketHandler = new CarRentalSocketHandler(io);
      console.log("Emitting new booking to socket handler...");
      await socketHandler.handleNewBooking(booking);

      res.json({
        booking,
        nearbyDrivers: nearbyDrivers.length,
      });
    } catch (error) {
      console.error("Error in createBooking:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  // Get booking details
  async getBooking(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const booking = await prisma.carRentalBooking.findUnique({
        where: { id },
        include: {
          package: true,
          user: true,
          driver: true,
          transactions: true,
        },
      });

      if (!booking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      res.json({ booking });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  // Cancel booking
  async cancelBooking(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const booking = await prisma.carRentalBooking.findUnique({
        where: { id },
      });

      if (!booking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      if (booking.userId !== userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const updatedBooking = await prisma.carRentalBooking.update({
        where: { id },
        data: {
          status: "CANCELLED",
        },
      });

      // Notify driver if assigned
      if (booking.driverId) {
        io.to(`driver:${booking.driverId}`).emit("carRental:cancelled", {
          bookingId: id,
        });
      }

      res.json({ booking: updatedBooking });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  // Accept booking
  async acceptBooking(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const driverId = req.user?.userId;

      if (!driverId) {
        return res.status(401).json({ error: "Driver not authenticated" });
      }

      const booking = await prisma.carRentalBooking.findUnique({
        where: { id },
        include: { driver: true },
      });

      if (!booking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      if (booking.status !== "SEARCHING") {
        return res
          .status(400)
          .json({ error: "Booking is no longer available" });
      }

      // Get driver's current location
      const driverStatus = await prisma.driverStatus.findUnique({
        where: { driverId },
      });

      if (
        !driverStatus ||
        !driverStatus.locationLat ||
        !driverStatus.locationLng
      ) {
        return res.status(400).json({ error: "Driver location not found" });
      }

      const pickupDistance = calculateDistance(
        driverStatus.locationLat,
        driverStatus.locationLng,
        booking.pickupLat,
        booking.pickupLng
      );

      const pickupDuration = calculateDuration(pickupDistance);

      const updatedBooking = await prisma.carRentalBooking.update({
        where: { id },
        data: {
          driverId,
          status: "ACCEPTED",
          driverAcceptedAt: new Date(),
          pickupDistance,
          pickupDuration,
        },
        include: {
          driver: true,
          user: true,
        },
      });

      // Notify via socket
      io.to(`user:${booking.userId}`).emit("carRental:accepted", {
        booking: updatedBooking,
      });

      res.json({ booking: updatedBooking });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  // Reject booking
  async rejectBooking(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const driverId = req.user?.userId;

      if (!driverId) {
        return res.status(401).json({ error: "Driver not authenticated" });
      }

      const booking = await prisma.carRentalBooking.findUnique({
        where: { id },
      });

      if (!booking || booking.status !== "SEARCHING") {
        return res.status(400).json({ error: "Invalid booking" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  // Get available bookings for driver
  async getAvailableBookings(req: Request, res: Response) {
    try {
      const driverId = req.user?.userId;

      if (!driverId) {
        return res.status(401).json({ error: "Driver not authenticated" });
      }

      // Get driver's current location
      const driverStatus = await prisma.driverStatus.findUnique({
        where: { driverId },
      });

      if (
        !driverStatus ||
        !driverStatus.locationLat ||
        !driverStatus.locationLng
      ) {
        return res.status(400).json({ error: "Driver location not found" });
      }

      // Find all SEARCHING bookings
      const availableBookings = await prisma.carRentalBooking.findMany({
        where: {
          status: "SEARCHING",
        },
        include: {
          package: true,
          user: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
        },
      });

      // Calculate distance and duration for each booking using Google Maps
      const bookingsWithDistance = await Promise.all(
        availableBookings.map(async (booking) => {
          const { distance, duration } = await getDistanceMatrix(
            driverStatus.locationLat!,
            driverStatus.locationLng!,
            booking.pickupLat,
            booking.pickupLng
          );

          return {
            ...booking,
            pickupDistance: distance,
            pickupDuration: duration,
            formattedDistance: `${distance.toFixed(1)} km`,
            formattedDuration:
              duration > 60
                ? `${Math.floor(duration / 60)}h ${duration % 60}m`
                : `${duration} mins`,
          };
        })
      );

      // Filter bookings within reasonable distance (e.g., 10km)
      const nearbyBookings = bookingsWithDistance
        .filter((booking) => booking.pickupDistance <= 10)
        .sort((a, b) => a.pickupDistance - b.pickupDistance);

      res.json({ bookings: nearbyBookings });
    } catch (error) {
      console.error("Error in getAvailableBookings:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
}
