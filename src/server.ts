import express from "express";
import http from "http";
import cors from "cors";
import { Server, Socket } from "socket.io";
import { authRouter } from "./routes/auth";
import { userRouter } from "./routes/user";
import { rideRouter } from "./routes/ride";
import { PrismaClient } from "@prisma/client";
import { driverRouter } from "./routes/driver";

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
      rideId: string;
      locationLat: number;
      locationLng: number;
    }) => {
      const { rideId, locationLat, locationLng } = data;
      try {
        // Find the ride with its associated user
        const ride = await prisma.ride.findUnique({
          where: { id: rideId },
          select: { userId: true },
        });

        if (ride) {
          // Emit location update only to the specific user who booked the ride
          io.to(ride.userId).emit("driver_location", {
            rideId,
            locationLat,
            locationLng,
          });
        } else {
          console.log(`No ride found with ID: ${rideId}`);
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
    "accept_ride",
    async (data: { rideId: string; driverId: string }) => {
      const { rideId, driverId } = data;
      // Update the ride with the driverId and status
      const ride = await prisma.ride.update({
        where: { id: rideId },
        data: { driverId, status: "ACCEPTED" },
        include: { user: true },
      });

      // Notify the user that a driver has accepted the ride
      io.to(ride.userId).emit("ride_accepted", {
        rideId,
        driver: await prisma.user.findUnique({ where: { id: driverId } }),
      });
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
