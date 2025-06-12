import { RideStatus } from "@prisma/client";
import cors from "cors";
import express from "express";
import http from "http";
import cron from "node-cron";
import { Server, Socket } from "socket.io";
import { setupPaymentSocketEvents } from "./controllers/paymentController";
import {
  calculateDistance,
  calculateDuration,
  validateRideChatAccess,
} from "./controllers/rideController";
import { prisma } from "./lib/prisma";
import { adminRouter } from "./routes/admin";
import { adminFareRoutes } from "./routes/adminFareRoutes";
import { allIndiaRoutes } from "./routes/allIndiaRoutes";
import { authRouter } from "./routes/auth";
import { chardhamRoutes } from "./routes/chardhamRoutes";
import { driverRouter } from "./routes/driver";
import { driverEarningsRoutes } from "./routes/driverEarningRoutes";
import { hillStationRouter } from "./routes/hillStationRoutes";
import { outstationRouter } from "./routes/outstationRoutes";
import { paymentRouter } from "./routes/payment";
import { rideRouter } from "./routes/ride";
import { userRouter } from "./routes/user";
import { userWalletRouter } from "./routes/userWallet";
import { vendorRouter } from "./routes/vendorRoutes";
import { vendorWalletRouter } from "./routes/vendorWallet";
import { walletRouter } from "./routes/wallet";
import { AutoCancellationService } from "./services/autoCancellationService";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  },
});

console.log(process.env.DATABASE_URL);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "70mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.set("io", io);

export { io };

// Routes
app.use("/api/auth", authRouter);
app.use("/api/users", userRouter);
app.use("/api/rides", rideRouter);
app.use("/api/drivers", driverRouter);
app.use("/api/payments", paymentRouter);
app.use("/api/wallets", walletRouter);
app.use("/api/user-wallet", userWalletRouter);
app.use("/api/admin", adminRouter);
app.use("/api/admin/fares", adminFareRoutes);
app.use("/api/driver-earnings", driverEarningsRoutes);
app.use("/api/outstation", outstationRouter);
app.use("/api/hill-station", hillStationRouter);
app.use("/api/vendor", vendorRouter);
app.use("/api/vendor-wallet", vendorWalletRouter);
app.use("/api/all-india", allIndiaRoutes);
app.use("/api/chardham", chardhamRoutes);
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

        // Broadcast cancellation event to all connected clients if cancelled
        if (updatedStatus === RideStatus.CANCELLED) {
          io.emit("ride_cancelled", {
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
            select: {
              status: true,
              pickupLocation: true,
              pickupLat: true,
              pickupLng: true,
            },
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

          // Calculate pickup metrics by passing both the driver's location and the ride's stored pickup coordinates
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

          // Broadcast to all connected clients that the ride is no longer available
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

        // Notify the user about ride acceptance
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

  // Outstation booking socket events
  socket.on(
    "join_outstation_booking",
    (data: { bookingId: string; userId: string }) => {
      console.log("join_outstation_booking", data);
      socket.join(data.bookingId);
      socket.join(data.userId);
    }
  );

  // Driver location updates for outstation
  socket.on(
    "outstation_driver_location",
    async (data: {
      bookingId: string;
      driverId: string;
      locationLat: number;
      locationLng: number;
    }) => {
      try {
        const booking = await prisma.longDistanceBooking.findUnique({
          where: { id: data.bookingId },
          select: { userId: true, status: true },
        });

        if (booking && booking.status !== "CANCELLED") {
          io.to(booking.userId).emit("driver_location_update", {
            bookingId: data.bookingId,
            location: {
              lat: data.locationLat,
              lng: data.locationLng,
            },
          });
        }
      } catch (error) {
        console.error("Error in location update:", error);
      }
    }
  );

  // Payment related events
  socket.on(
    "outstation_payment_initiated",
    (data: { bookingId: string; type: "ADVANCE" | "FINAL" }) => {
      console.log("outstation_payment_initiated", data);
      io.to(data.bookingId).emit("payment_initiated", {
        bookingId: data.bookingId,
        type: data.type,
      });
    }
  );

  // Ride completion events
  socket.on(
    "outstation_ride_completion_initiated",

    (data: { bookingId: string }) => {
      console.log("outstation_ride_completion_initiated", data);
      io.to(data.bookingId).emit("ride_completion_initiated", {
        bookingId: data.bookingId,
      });
    }
  );

  socket.on(
    "outstation_ride_completed",
    (data: { bookingId: string; paymentMode: string }) => {
      console.log("outstation_ride_completed", data);
      io.to(data.bookingId).emit("ride_completed", {
        bookingId: data.bookingId,
        paymentMode: data.paymentMode,
      });
    }
  );

  // Hill station booking socket events
  socket.on(
    "join_hill_station_booking",
    (data: { bookingId: string; userId: string }) => {
      console.log("join_hill_station_booking", data);
      socket.join(data.bookingId);
      socket.join(data.userId);
    }
  );

  // Driver location updates for hill station
  socket.on(
    "hill_station_driver_location",
    async (data: {
      bookingId: string;
      driverId: string;
      locationLat: number;
      locationLng: number;
      heading?: number;
      speed?: number;
    }) => {
      try {
        const booking = await prisma.longDistanceBooking.findUnique({
          where: {
            id: data.bookingId,
            serviceType: "HILL_STATION",
          },
          select: { userId: true, status: true },
        });

        if (booking && booking.status !== "CANCELLED") {
          io.to(booking.userId).emit("driver_location_update", {
            bookingId: data.bookingId,
            location: {
              lat: data.locationLat,
              lng: data.locationLng,
              heading: data.heading,
              speed: data.speed,
            },
          });
        }
      } catch (error) {
        console.error("Error in hill station location update:", error);
      }
    }
  );

  // Payment related events for hill station
  socket.on(
    "hill_station_payment_initiated",
    (data: {
      bookingId: string;
      type: "ADVANCE" | "FINAL";
      amount: number;
    }) => {
      console.log("hill_station_payment_initiated", data);
      io.to(data.bookingId).emit("payment_initiated", {
        bookingId: data.bookingId,
        type: data.type,
        amount: data.amount,
      });
    }
  );

  // Ride status events for hill station
  socket.on(
    "hill_station_driver_pickup_started",
    (data: { bookingId: string; driverId: string; estimatedTime?: number }) => {
      console.log("hill_station_driver_pickup_started", data);
      io.to(data.bookingId).emit("driver_pickup_started", {
        bookingId: data.bookingId,
        driverId: data.driverId,
        estimatedTime: data.estimatedTime,
      });
    }
  );

  socket.on(
    "hill_station_driver_arrived",
    (data: { bookingId: string; driverId: string }) => {
      console.log("hill_station_driver_arrived", data);
      io.to(data.bookingId).emit("driver_arrived", {
        bookingId: data.bookingId,
        driverId: data.driverId,
      });
    }
  );

  socket.on(
    "hill_station_ride_started",
    (data: { bookingId: string; driverId: string }) => {
      console.log("hill_station_ride_started", data);
      io.to(data.bookingId).emit("ride_started", {
        bookingId: data.bookingId,
        driverId: data.driverId,
      });
    }
  );

  // Ride completion events for hill station
  socket.on(
    "hill_station_ride_completion_initiated",
    (data: {
      bookingId: string;
      remainingAmount: number;
      driverDetails?: {
        name: string;
        phone: string;
      };
    }) => {
      console.log("hill_station_ride_completion_initiated", data);
      io.to(data.bookingId).emit("ride_completion_initiated", {
        bookingId: data.bookingId,
        remainingAmount: data.remainingAmount,
        driverDetails: data.driverDetails,
      });
    }
  );

  socket.on(
    "hill_station_ride_completed",
    (data: {
      bookingId: string;
      paymentMode: string;
      paymentStatus: string;
      amount: number;
      userDetails?: {
        name: string;
        phone: string;
      };
      driverDetails?: {
        name: string;
        phone: string;
      };
    }) => {
      console.log("hill_station_ride_completed", data);
      io.to(data.bookingId).emit("ride_completed", {
        bookingId: data.bookingId,
        paymentMode: data.paymentMode,
        paymentStatus: data.paymentStatus,
        amount: data.amount,
        userDetails: data.userDetails,
        driverDetails: data.driverDetails,
      });
    }
  );

  // Booking cancellation event
  socket.on(
    "hill_station_booking_cancelled",
    (data: {
      bookingId: string;
      reason: string;
      cancelledBy: string;
      userId: string;
      driverId?: string;
    }) => {
      console.log("hill_station_booking_cancelled", data);

      // Notify both user and driver if exists
      io.to(data.userId).emit("booking_cancelled", {
        bookingId: data.bookingId,
        reason: data.reason,
        cancelledBy: data.cancelledBy,
      });

      if (data.driverId) {
        io.to(data.driverId).emit("booking_cancelled", {
          bookingId: data.bookingId,
          reason: data.reason,
          cancelledBy: data.cancelledBy,
        });
      }
    }
  );

  // Error handling for hill station events
  socket.on(
    "hill_station_error",
    (data: { bookingId: string; error: string; type: string }) => {
      console.error("Hill station error:", data);
      io.to(data.bookingId).emit("booking_error", {
        bookingId: data.bookingId,
        error: data.error,
        type: data.type,
      });
    }
  );

  // All India Tour booking socket events
  socket.on(
    "join_all_india_booking",
    (data: { bookingId: string; userId: string }) => {
      console.log("join_all_india_booking", data);
      socket.join(data.bookingId);
      socket.join(data.userId);
    }
  );

  // Driver location updates for All India Tour
  socket.on(
    "all_india_driver_location",
    async (data: {
      bookingId: string;
      driverId: string;
      locationLat: number;
      locationLng: number;
      heading?: number;
      speed?: number;
    }) => {
      try {
        const booking = await prisma.longDistanceBooking.findUnique({
          where: {
            id: data.bookingId,
            serviceType: "ALL_INDIA_TOUR",
          },
          select: { userId: true, status: true },
        });

        if (booking && booking.status !== "CANCELLED") {
          io.to(booking.userId).emit("driver_location_update", {
            bookingId: data.bookingId,
            location: {
              lat: data.locationLat,
              lng: data.locationLng,
              heading: data.heading,
              speed: data.speed,
            },
          });
        }
      } catch (error) {
        console.error("Error in All India location update:", error);
      }
    }
  );

  // Payment related events for All India Tour
  socket.on(
    "all_india_payment_initiated",
    (data: {
      bookingId: string;
      type: "ADVANCE" | "FINAL";
      amount: number;
      driverDetails?: {
        name: string;
        phone: string;
      };
    }) => {
      console.log("all_india_payment_initiated", data);
      io.to(data.bookingId).emit("payment_initiated", {
        bookingId: data.bookingId,
        type: data.type,
        amount: data.amount,
        driverDetails: data.driverDetails,
      });
    }
  );

  // Ride completion events for All India Tour
  socket.on(
    "all_india_ride_completion_initiated",
    (data: {
      bookingId: string;
      remainingAmount: number;
      driverDetails?: {
        name: string;
        phone: string;
      };
    }) => {
      console.log("all_india_ride_completion_initiated", data);
      io.to(data.bookingId).emit("ride_completion_initiated", {
        bookingId: data.bookingId,
        remainingAmount: data.remainingAmount,
        driverDetails: data.driverDetails,
        serviceType: "ALL_INDIA_TOUR",
      });
    }
  );

  socket.on(
    "all_india_ride_completed",
    (data: {
      bookingId: string;
      paymentMode: string;
      paymentStatus: string;
      amount: number;
      userDetails?: {
        name: string;
        phone: string;
      };
      driverDetails?: {
        name: string;
        phone: string;
      };
    }) => {
      console.log("all_india_ride_completed", data);
      io.to(data.bookingId).emit("ride_completed", {
        bookingId: data.bookingId,
        paymentMode: data.paymentMode,
        paymentStatus: data.paymentStatus,
        amount: data.amount,
        userDetails: data.userDetails,
        driverDetails: data.driverDetails,
        serviceType: "ALL_INDIA_TOUR",
      });
    }
  );

  // Booking cancellation event for All India Tour
  socket.on(
    "all_india_booking_cancelled",
    (data: {
      bookingId: string;
      reason: string;
      cancelledBy: string;
      userId: string;
      driverId?: string;
    }) => {
      console.log("all_india_booking_cancelled", data);

      // Notify both user and driver if exists
      io.to(data.userId).emit("booking_cancelled", {
        bookingId: data.bookingId,
        reason: data.reason,
        cancelledBy: data.cancelledBy,
        serviceType: "ALL_INDIA_TOUR",
      });

      if (data.driverId) {
        io.to(data.driverId).emit("booking_cancelled", {
          bookingId: data.bookingId,
          reason: data.reason,
          cancelledBy: data.cancelledBy,
          serviceType: "ALL_INDIA_TOUR",
        });
      }
    }
  );

  // Error handling for All India Tour events
  socket.on(
    "all_india_error",
    (data: { bookingId: string; error: string; type: string }) => {
      console.error("All India Tour error:", data);
      io.to(data.bookingId).emit("booking_error", {
        bookingId: data.bookingId,
        error: data.error,
        type: data.type,
        serviceType: "ALL_INDIA_TOUR",
      });
    }
  );

  socket.on(
    "join_ride_chat",
    async (data: { rideId: string; userId: string }) => {
      const { rideId, userId } = data;

      // Validate if user has access to this ride chat
      const hasAccess = await validateRideChatAccess(rideId, userId);
      if (!hasAccess) {
        socket.emit("chat_error", { message: "Unauthorized access to chat" });
        return;
      }

      socket.join(`ride_chat_${rideId}`);
      console.log(`User ${userId} joined ride chat ${rideId}`);
    }
  );

  socket.on(
    "send_message",
    async (data: { rideId: string; senderId: string; message: string }) => {
      const { rideId, senderId, message } = data;

      try {
        // Get ride details to identify the other participant
        const ride = await prisma.ride.findUnique({
          where: { id: rideId },
          select: { userId: true, driverId: true },
        });

        if (!ride) {
          socket.emit("chat_error", { message: "Ride not found" });
          return;
        }

        // Save message to database
        const chatMessage = await prisma.chatMessage.create({
          data: {
            rideId,
            senderId,
            message,
          },
          include: {
            sender: {
              select: {
                name: true,
                userType: true,
              },
            },
          },
        });

        // Broadcast message to ride chat room
        io.to(`ride_chat_${rideId}`).emit("new_message", {
          ...chatMessage,
          createdAt: chatMessage.createdAt.toISOString(),
        });

        // Identify recipient and emit unread count notification
        const recipientId =
          senderId === ride.userId ? ride.driverId : ride.userId;

        if (recipientId) {
          // Count unread messages for recipient
          const unreadCount = await prisma.chatMessage.count({
            where: {
              rideId,
              senderId: { not: recipientId },
              read: false,
            },
          });

          // Emit unread message count to recipient
          io.to(recipientId).emit("unread_messages_update", {
            rideId,
            unreadCount,
          });
        }
      } catch (error) {
        console.error("Error sending message:", error);
        socket.emit("chat_error", { message: "Failed to send message" });
      }
    }
  );

  socket.on(
    "mark_messages_read",
    async (data: { rideId: string; userId: string }) => {
      const { rideId, userId } = data;

      try {
        // Get ride details to identify the other participant
        const ride = await prisma.ride.findUnique({
          where: { id: rideId },
          select: { userId: true, driverId: true },
        });

        if (!ride) {
          socket.emit("chat_error", { message: "Ride not found" });
          return;
        }

        // Mark messages as read
        await prisma.chatMessage.updateMany({
          where: {
            rideId,
            senderId: { not: userId },
            read: false,
          },
          data: {
            read: true,
          },
        });

        // Emit that messages have been read to the chat room
        io.to(`ride_chat_${rideId}`).emit("messages_read", {
          rideId,
          readBy: userId,
        });

        // Emit updated unread count (which is now 0) to the user who read the messages
        io.to(userId).emit("unread_messages_update", {
          rideId,
          unreadCount: 0,
        });

        // Identify the other participant (sender of those messages)
        const otherParticipantId =
          userId === ride.userId ? ride.driverId : ride.userId;

        if (otherParticipantId) {
          // Notify sender that their messages have been read
          io.to(otherParticipantId).emit("messages_read_by_other", {
            rideId,
            readBy: userId,
          });
        }
      } catch (error) {
        console.error("Error marking messages as read:", error);
        socket.emit("chat_error", {
          message: "Failed to mark messages as read",
        });
      }
    }
  );

  // New event to get unread message count
  socket.on(
    "get_unread_count",
    async (data: { rideId: string; userId: string }) => {
      const { rideId, userId } = data;

      try {
        // Validate if user has access to this ride chat
        const hasAccess = await validateRideChatAccess(rideId, userId);
        if (!hasAccess) {
          socket.emit("chat_error", { message: "Unauthorized access to chat" });
          return;
        }

        // Count unread messages
        const unreadCount = await prisma.chatMessage.count({
          where: {
            rideId,
            senderId: { not: userId },
            read: false,
          },
        });

        // Send count to requesting user
        socket.emit("unread_count_result", {
          rideId,
          unreadCount,
        });
      } catch (error) {
        console.error("Error getting unread count:", error);
        socket.emit("chat_error", { message: "Failed to get unread count" });
      }
    }
  );

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});
// Initialize auto-cancellation cron job
// Runs every minute to check for overdue bookings
cron.schedule(
  "* * * * *",
  async () => {
    try {
      await AutoCancellationService.checkAndCancelOverdueBookings();
    } catch (error) {
      console.error("[AutoCancellation] Cron job error:", error);
    }
  },
  {
    timezone: "Asia/Kolkata", // Run in IST timezone
    scheduled: true,
  }
);

console.log(
  "[AutoCancellation] Cron job scheduled to run every minute in IST timezone"
);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("[AutoCancellation] Auto-cancellation service is active");
});
