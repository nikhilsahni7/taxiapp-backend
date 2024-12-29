import express from "express";
import http from "http";
import cors from "cors";
import { Server, Socket } from "socket.io";
import { authRouter } from "./routes/auth";
import { userRouter } from "./routes/user";
import { rideRouter } from "./routes/ride";
import { PrismaClient, RideStatus } from "@prisma/client";
import { driverRouter } from "./routes/driver";
import { paymentRouter } from "./routes/payment";
import { walletRouter } from "./routes/wallet";
import { adminRouter } from "./routes/admin";
import { setupPaymentSocketEvents } from "./controllers/paymentController";
import {
  calculateDistance,
  calculateDuration,
} from "./controllers/rideController";
import { isRideRequestValid } from "./controllers/outstationController";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
    allowedHeaders: ["Content-Type"],
  },
});
const prisma = new PrismaClient();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json());

app.set("io", io);

export { io };

// Routes
app.use("/api/auth", authRouter);
app.use("/api/users", userRouter);
app.use("/api/rides", rideRouter);
app.use("/api/drivers", driverRouter);
app.use("/api/payments", paymentRouter);
app.use("/api/wallets", walletRouter);
app.use("/api/admin", adminRouter);

app.use("/", (req, res) => {
  res.send("Welcome to the taxiSure API");
});
io.on("connection", (socket: Socket) => {
  console.log("User connected:", socket.id);

  socket.on("join_room", (data: { userId: string }) => {
    socket.join(data.userId);
  });

  socket.on("register_driver", async (data: { driverId: string }) => {
    const { driverId } = data;
    await prisma.driverStatus.upsert({
      where: { driverId },
      update: { socketId: socket.id, isOnline: true },
      create: {
        driverId,
        socketId: socket.id,
        isOnline: true,
      },
    });
  });

  setupPaymentSocketEvents(socket);

  socket.on(
    "driver_location_update",
    async (data: {
      rideId?: string;
      driverId: string;
      locationLat: number;
      locationLng: number;
      heading?: number;
      speed?: number;
    }) => {
      const { rideId, locationLat, locationLng, driverId, heading, speed } =
        data;
      try {
        if (rideId) {
          const ride = await prisma.ride.findUnique({
            where: { id: rideId },
            select: { userId: true, status: true },
          });

          if (ride && ride.status !== RideStatus.CANCELLED) {
            io.to(ride.userId).emit("driver_location", {
              rideId,
              locationLat,
              locationLng,
              heading,
              speed,
            });
          }
        }

        // Always update driver's location in database
        await prisma.driverStatus.update({
          where: { driverId },
          data: {
            locationLat,
            locationLng,
            lastLocationUpdate: new Date(),
          },
        });
      } catch (error) {
        console.error("Error in driver location update:", error);
      }
    }
  );

  socket.on(
    "driver_response",
    async (data: { rideId: string; driverId: string; accepted: boolean }) => {
      const { rideId, driverId, accepted } = data;
      io.emit(`driver_response_${rideId}_${driverId}`, { accepted });
    }
  );
  socket.on(
    "update_driver_availability",
    async (data: {
      driverId: string;
      locationLat: number;
      locationLng: number;
      isOnline: boolean;
    }) => {
      const { driverId, locationLat, locationLng, isOnline } = data;

      try {
        // Update driver status in database
        const updatedDriverStatus = await prisma.driverStatus.upsert({
          where: { driverId },
          update: {
            locationLat,
            locationLng,
            isOnline,
            updatedAt: new Date(),
          },
          create: {
            driverId,
            locationLat,
            locationLng,
            isOnline,
          },
        });

        console.log("Driver status updated:", updatedDriverStatus);

        // Broadcast status update to all connected clients
        io.emit(`driver_availability_changed_${driverId}`, {
          driverId,
          locationLat,
          locationLng,
          isOnline,
        });
      } catch (error) {
        console.error("Error updating driver availability:", error);
      }
    }
  );

  socket.on(
    "update_ride_status",
    async (data: { rideId: string; status: string }) => {
      const { rideId, status } = data;

      try {
        // Map the string status to the RideStatus enum
        let updatedStatus: RideStatus;

        switch (status) {
          case "SEARCHING":
            updatedStatus = RideStatus.SEARCHING;
            break;
          case "ACCEPTED":
            updatedStatus = RideStatus.ACCEPTED;
            break;
          case "DRIVER_ARRIVED":
            updatedStatus = RideStatus.DRIVER_ARRIVED;
            break;
          case "RIDE_STARTED":
            updatedStatus = RideStatus.RIDE_STARTED;
            break;
          case "RIDE_ENDED":
            updatedStatus = RideStatus.RIDE_ENDED;
            break;
          case "CANCELLED":
            updatedStatus = RideStatus.CANCELLED;
            break;
          default:
            console.error("Invalid ride status:", status);
            return;
        }

        const ride = await prisma.ride.update({
          where: { id: rideId },
          data: { status: updatedStatus },
          include: { user: true, driver: true },
        });

        // Notify user and driver about the status update
        if (ride.userId) {
          io.to(ride.userId).emit("ride_status_update", {
            rideId,
            status: updatedStatus,
          });
        }

        if (ride.driverId) {
          io.to(ride.driverId).emit("ride_status_update", {
            rideId,
            status: updatedStatus,
          });
        }
      } catch (error) {
        console.error("Error updating ride status:", error);
      }
    }
  );

  socket.on(
    "accept_ride",
    async (data: { rideId: string; driverId: string }) => {
      const { rideId, driverId } = data;

      try {
        // Use a transaction with pessimistic locking
        const result = await prisma.$transaction(async (prisma) => {
          // First check if ride is still available
          const existingRide = await prisma.ride.findFirst({
            where: {
              id: rideId,
              status: RideStatus.SEARCHING,
              driverId: null,
            },
            select: { status: true, pickupLocation: true },
            orderBy: { createdAt: "asc" },
            take: 1,
          });

          if (!existingRide) {
            return {
              success: false,
              message: "Ride is no longer available",
            };
          }

          // Get driver's current location
          const driverStatus = await prisma.driverStatus.findUnique({
            where: { driverId },
          });

          if (!driverStatus) {
            return {
              success: false,
              message: "Driver status not found",
            };
          }

          // Calculate pickup metrics
          const pickupDistance = await calculateDistance(
            `${driverStatus.locationLat},${driverStatus.locationLng}`,
            existingRide.pickupLocation
          );

          const pickupDuration = await calculateDuration(
            `${driverStatus.locationLat},${driverStatus.locationLng}`,
            existingRide.pickupLocation
          );

          // Update ride status immediately to prevent race conditions
          const updatedRide = await prisma.ride.update({
            where: {
              id: rideId,
              status: RideStatus.SEARCHING,
            },
            data: {
              status: RideStatus.ACCEPTED,
              driverId: driverId,
              pickupDistance,
              pickupDuration,
            },
            include: { user: true },
          });

          // Broadcast to all connected clients that ride is no longer available
          io.emit("ride_unavailable", { rideId });

          return {
            success: true,
            ride: updatedRide,
            pickupDistance,
            pickupDuration,
          };
        });

        if (!result.success || !result.ride) {
          socket.emit("ride_acceptance_response", {
            success: false,
            message: result.message || "Ride not found",
          });
          return;
        }

        // Notify the user
        io.to(result.ride.userId).emit("ride_status_update", {
          rideId,
          status: "ACCEPTED",
          driverId,
          pickupDistance: result.pickupDistance,
          pickupDuration: result.pickupDuration,
        });

        // Send success response to driver
        socket.emit("ride_acceptance_response", {
          success: true,
          message: "Ride accepted successfully",
          ride: result.ride,
        });
      } catch (error) {
        console.error("Error in accept_ride:", error);
        socket.emit("ride_acceptance_response", {
          success: false,
          message: "Failed to accept ride",
        });
      }
    }
  );

  socket.on(
    "accept_outstation_ride",
    async (data: { rideId: string; driverId: string }) => {
      try {
        // Check if ride request is still valid
        if (!(await isRideRequestValid(data.rideId))) {
          socket.emit("outstation_ride_response", {
            success: false,
            message: "Ride request has expired or is no longer available",
          });
          return;
        }

        const updatedRide = await prisma.ride.update({
          where: {
            id: data.rideId,
            status: RideStatus.SEARCHING,
          },
          data: {
            driverId: data.driverId,
            status: RideStatus.ACCEPTED,
            isDriverAccepted: true,
            driverAcceptedAt: new Date(),
          },
          include: {
            driver: {
              select: {
                name: true,
                phone: true,
                driverDetails: true,
              },
            },
          },
        });

        // Notify user
        io.to(updatedRide.userId).emit("outstation_ride_accepted", {
          rideId: updatedRide.id,
          driver: updatedRide.driver,
        });

        // Notify other drivers
        io.emit("outstation_ride_unavailable", { rideId: updatedRide.id });

        socket.emit("outstation_ride_response", {
          success: true,
          message: "Ride accepted successfully",
          ride: updatedRide,
        });
      } catch (error) {
        console.error("Error accepting outstation ride:", error);
        socket.emit("outstation_ride_response", {
          success: false,
          message: "Failed to accept ride",
        });
      }
    }
  );
  socket.on("disconnect", async () => {
    console.log("User disconnected:", socket.id);
    await prisma.driverStatus.updateMany({
      where: { socketId: socket.id },
      data: { isOnline: false, socketId: null },
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
