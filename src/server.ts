import express from "express";
import http from "http";
import cors from "cors";
import { Server, Socket } from "socket.io";
import { authRouter } from "./routes/auth";
import { userRouter } from "./routes/user";
import { rideRouter } from "./routes/ride";
import { PrismaClient } from "@prisma/client";
import { driverRouter } from "./routes/driver";
import { RideStatus } from "@prisma/client";

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

  socket.on(
    "driver_location_update",
    async (data: {
      rideId?: string;
      driverId: string;
      locationLat: number;
      locationLng: number;
    }) => {
      const { rideId, locationLat, locationLng, driverId } = data;
      try {
        if (rideId) {
          // Find the ride and emit location to the user
          const ride = await prisma.ride.findUnique({
            where: { id: rideId },
            select: { userId: true },
          });

          if (ride) {
            io.to(ride.userId).emit("driver_location", {
              rideId,
              locationLat,
              locationLng,
            });
          } else {
            console.log(`No ride found with ID: ${rideId}`);
          }
        } else {
          // Update driver's general location if not on a ride
          await prisma.driverStatus.update({
            where: { driverId },
            data: { locationLat, locationLng },
          });
        }
      } catch (error) {
        console.error("Error in driver location update:", error);
      }
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
      // Update the ride in the database
      const ride = await prisma.ride.update({
        where: { id: rideId },
        data: { driverId, status: "ACCEPTED" },
        include: { user: true },
      });

      const driverStatus = await prisma.driverStatus.findUnique({
        where: { driverId },
      });

      console.log("Ride details:", ride);
      console.log("Driver details:", driverStatus);

      // Notify the user that the ride was accepted
      io.to(ride.userId).emit("ride_status_update", {
        rideId,
        status: "ACCEPTED",
        driverId,
      });

      // Notify the driver with ride details
      if (driverStatus?.socketId) {
        io.to(driverStatus.socketId).emit("ride_assigned", {
          rideId,
          rideDetails: ride,
        });
      }

      console.log(`Ride ${rideId} accepted by driver ${driverId}`);
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
