import { Server, Socket } from "socket.io";
import { PrismaClient } from "@prisma/client";
import { searchAvailableDrivers } from "../lib/driverService";
import { getDistanceMatrix } from "../utils/googleMaps";

const prisma = new PrismaClient();

export class CarRentalSocketHandler {
  private readonly io: Server;
  private readonly activeDrivers: Map<
    string,
    { socket: Socket; location: { lat: number; lng: number } }
  >;

  constructor(io: Server) {
    this.io = io;
    this.activeDrivers = new Map();
  }

  registerDriver(
    socket: Socket,
    data: { driverId: string; location: { lat: number; lng: number } }
  ) {
    console.log("Registering driver:", data);

    // Update driver status in database
    prisma.driverStatus
      .upsert({
        where: { driverId: data.driverId },
        create: {
          driverId: data.driverId,
          isOnline: true,
          locationLat: data.location.lat,
          locationLng: data.location.lng,
          socketId: socket.id,
          lastLocationUpdate: new Date(),
        },
        update: {
          isOnline: true,
          locationLat: data.location.lat,
          locationLng: data.location.lng,
          socketId: socket.id,
          lastLocationUpdate: new Date(),
        },
      })
      .catch((error) => {
        console.error("Error updating driver status:", error);
      });

    // Store in memory for quick access
    this.activeDrivers.set(data.driverId, {
      socket,
      location: data.location,
    });
  }

  // Handle new booking request
  async handleNewBooking(booking: any) {
    console.log("Handling new booking...");

    try {
      const nearbyDrivers = await searchAvailableDrivers(
        `${booking.pickupLat},${booking.pickupLng}`,
        10
      );

      console.log("Found nearby drivers:", nearbyDrivers.length);

      // Match drivers with active socket connections and calculate distances
      const availableDrivers = await Promise.all(
        nearbyDrivers
          .filter((driverStatus) =>
            this.activeDrivers.has(driverStatus.driverId)
          )
          .map(async (driverStatus) => {
            const { distance, duration } = await getDistanceMatrix(
              driverStatus.locationLat!,
              driverStatus.locationLng!,
              booking.pickupLat,
              booking.pickupLng
            );

            return {
              ...driverStatus,
              pickupDistance: distance,
              pickupDuration: duration,
              socket: this.activeDrivers.get(driverStatus.driverId)?.socket,
            };
          })
      );

      // Sort by nearest first and emit to drivers
      availableDrivers
        .sort((a, b) => a.pickupDistance - b.pickupDistance)
        .forEach((driver) => {
          driver.socket?.emit("carRental:request", {
            ...booking,
            pickupDistance: driver.pickupDistance,
            pickupDuration: driver.pickupDuration,
          });
        });

      // Set timeout for booking expiry (2 minutes)
      setTimeout(async () => {
        const updatedBooking = await prisma.carRentalBooking.findUnique({
          where: { id: booking.id },
        });

        if (updatedBooking?.status === "SEARCHING") {
          await prisma.carRentalBooking.update({
            where: { id: booking.id },
            data: { status: "CANCELLED" },
          });

          this.io.to(`user:${booking.userId}`).emit("carRental:expired", {
            bookingId: booking.id,
          });
        }
      }, 120000);
    } catch (error) {
      console.error("Error handling new booking:", error);
    }
  }

  // Handle driver response
  async handleDriverResponse(socket: Socket, data: any) {
    console.log("handleDriverResponse called with data:", data);
    const { bookingId, accept } = data;

    if (!accept) {
      console.log("Driver rejected booking:", bookingId);
      return;
    }

    const booking = await prisma.carRentalBooking.findUnique({
      where: { id: bookingId },
    });

    if (!booking || booking.status !== "SEARCHING") {
      socket.emit("carRental:error", {
        message: "Booking no longer available",
      });
      return;
    }

    // Update booking with driver details
    const updatedBooking = await prisma.carRentalBooking.update({
      where: { id: bookingId },
      data: {
        driverId: socket.data.userId,
        status: "ACCEPTED",
        driverAcceptedAt: new Date(),
      },
      include: {
        driver: true,
      },
    });

    // Notify user and driver
    this.io.to(`user:${booking.userId}`).emit("carRental:accepted", {
      booking: updatedBooking,
    });

    socket.emit("carRental:confirmed", {
      booking: updatedBooking,
    });
  }

  // Handle driver location updates
  handleDriverLocation(socket: Socket, data: any) {
    const { lat, lng } = data;
    const driverId = socket.data.userId;

    if (driverId && this.activeDrivers.has(driverId)) {
      // Update in-memory location
      this.activeDrivers.get(driverId)!.location = { lat, lng };

      // Update database
      prisma.driverStatus
        .update({
          where: { driverId },
          data: {
            locationLat: lat,
            locationLng: lng,
            lastLocationUpdate: new Date(),
          },
        })
        .catch((error) => {
          console.error("Error updating driver location in database:", error);
        });

      console.log(`Updated driver ${driverId} location:`, { lat, lng });
    }

    // Emit location update to user if in ride
    socket.rooms.forEach((room) => {
      if (room.startsWith("carRental:")) {
        const bookingId = room.split(":")[1];
        this.io.to(room).emit("driver:location", {
          bookingId,
          location: { lat, lng },
        });
      }
    });
  }

  // Handle ride start
  async handleRideStart(socket: Socket, data: any) {
    console.log("handleRideStart called with data:", data);
    const { bookingId, otp } = data;

    const booking = await prisma.carRentalBooking.findUnique({
      where: { id: bookingId },
    });

    if (!booking || booking.status !== "DRIVER_ARRIVED") {
      socket.emit("carRental:error", {
        message: "Invalid booking status",
      });
      return;
    }

    // Verify OTP here

    const updatedBooking = await prisma.carRentalBooking.update({
      where: { id: bookingId },
      data: {
        status: "STARTED",
        startTime: new Date(),
        rideStartedAt: new Date(),
      },
    });

    this.io.to(`carRental:${bookingId}`).emit("carRental:started", {
      booking: updatedBooking,
    });
  }

  // Handle ride end
  async handleRideEnd(socket: Socket, data: any) {
    console.log("handleRideEnd called with data:", data);
    const { bookingId, endLocation, totalDistance } = data;

    const booking = await prisma.carRentalBooking.findUnique({
      where: { id: bookingId },
      include: { package: true },
    });

    if (!booking || booking.status !== "STARTED") {
      socket.emit("carRental:error", {
        message: "Invalid booking status",
      });
      return;
    }

    const endTime = new Date();
    const durationInMinutes = Math.floor(
      (endTime.getTime() - booking.startTime!.getTime()) / (1000 * 60)
    );

    const extraMinutes = Math.max(0, durationInMinutes - booking.hours * 60);
    const extraKms = Math.max(0, totalDistance - booking.kilometers);

    const extraTimeCharge = extraMinutes * 2; // ₹2 per minute
    const extraKmCharge = extraKms * getExtraKmRate(booking.carType);

    const finalAmount = booking.baseAmount + extraTimeCharge + extraKmCharge;

    const updatedBooking = await prisma.carRentalBooking.update({
      where: { id: bookingId },
      data: {
        status: "COMPLETED",
        endTime,
        rideEndedAt: endTime,
        totalDistance,
        extraKms,
        extraMinutes,
        extraCharges: extraTimeCharge + extraKmCharge,
        finalAmount,
      },
    });

    this.io.to(`carRental:${bookingId}`).emit("carRental:completed", {
      booking: updatedBooking,
    });
  }
}

function getExtraKmRate(carType: string): number {
  switch (carType.toLowerCase()) {
    case "mini":
      return 14;
    case "sedan":
      return 16;
    case "suv":
      return 18;
    default:
      return 15;
  }
}

// Utility functions for distance and duration calculations
function calculateDistance(
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

function calculateDuration(distanceInKm: number): number {
  // Assuming average speed of 30 km/h in city traffic
  const averageSpeedKmH = 30;
  const timeInHours = distanceInKm / averageSpeedKmH;
  const timeInMinutes = Math.ceil(timeInHours * 60);

  return timeInMinutes;
}

function toRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}
