import { PrismaClient } from "@prisma/client";
import { io } from "../server";

const prisma = new PrismaClient();

/**
 * Auto-cancellation service for long distance bookings
 * Cancels bookings where pickup time has passed and no driver has accepted
 */
export class AutoCancellationService {
  /**
   * Check and cancel overdue bookings
   * Runs every minute to check for bookings that should be auto-cancelled
   */
  static async checkAndCancelOverdueBookings(): Promise<void> {
    try {
      console.log("[AutoCancellation] Starting overdue booking check...");

      // Get current time in IST (India Standard Time)
      const now = new Date();
      console.log(`[AutoCancellation] Current UTC time: ${now.toISOString()}`);
      console.log(`[AutoCancellation] Current IST time: ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);

      // Check both long distance bookings and vendor bookings
      await this.checkLongDistanceBookings(now);
      await this.checkVendorBookings(now);
    } catch (error) {
      console.error(
        "[AutoCancellation] Error during overdue booking check:",
        error
      );
    }
  }

  /**
   * Check and cancel overdue long distance bookings (with refund logic)
   */
  private static async checkLongDistanceBookings(currentTime: Date): Promise<void> {
    try {
      // Find all long distance bookings that are still waiting for driver acceptance
      const waitingBookings = await prisma.longDistanceBooking.findMany({
        where: {
          status: {
            in: ["PENDING", "ADVANCE_PAID"], // Statuses where no driver has accepted yet
          },
          // Include all bookings regardless of date for now, we'll filter by pickup time
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
        },
      });

      console.log(
        `[AutoCancellation] Found ${waitingBookings.length} long distance bookings to check`
      );

      const bookingsToCancel = [];

      // Check each booking to see if pickup time has passed
      for (const booking of waitingBookings) {
        const shouldCancel = this.shouldCancelBooking(booking, currentTime);
        if (shouldCancel) {
          bookingsToCancel.push(booking);
        }
      }

      console.log(
        `[AutoCancellation] Found ${bookingsToCancel.length} long distance bookings to cancel`
      );

      // Cancel the overdue bookings
      for (const booking of bookingsToCancel) {
        await this.cancelOverdueLongDistanceBooking(booking);
      }

      if (bookingsToCancel.length > 0) {
        console.log(
          `[AutoCancellation] Successfully cancelled ${bookingsToCancel.length} overdue long distance bookings`
        );
      }
    } catch (error) {
      console.error(
        "[AutoCancellation] Error checking long distance bookings:",
        error
      );
    }
  }

  /**
   * Check and cancel overdue vendor bookings (no refund needed)
   */
  private static async checkVendorBookings(currentTime: Date): Promise<void> {
    try {
      // Find all vendor bookings that are still waiting for driver acceptance
      const waitingVendorBookings = await prisma.vendorBooking.findMany({
        where: {
          status: "PENDING", // Only PENDING status as drivers haven't accepted yet
          // Include all bookings regardless of date for now, we'll filter by pickup time
        },
        include: {
          vendor: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
        },
      });

      console.log(
        `[AutoCancellation] Found ${waitingVendorBookings.length} vendor bookings to check`
      );

      const vendorBookingsToCancel = [];

      // Check each vendor booking to see if pickup time has passed
      for (const booking of waitingVendorBookings) {
        const shouldCancel = this.shouldCancelBooking(booking, currentTime);
        if (shouldCancel) {
          vendorBookingsToCancel.push(booking);
        }
      }

      console.log(
        `[AutoCancellation] Found ${vendorBookingsToCancel.length} vendor bookings to cancel`
      );

      // Cancel the overdue vendor bookings
      for (const booking of vendorBookingsToCancel) {
        await this.cancelOverdueVendorBooking(booking);
      }

      if (vendorBookingsToCancel.length > 0) {
        console.log(
          `[AutoCancellation] Successfully cancelled ${vendorBookingsToCancel.length} overdue vendor bookings`
        );
      }
    } catch (error) {
      console.error(
        "[AutoCancellation] Error checking vendor bookings:",
        error
      );
    }
  }

  /**
   * Determine if a booking should be cancelled based on pickup time
   */
  private static shouldCancelBooking(booking: any, currentTime: Date): boolean {
    try {
      console.log(`[AutoCancellation] Checking booking ${booking.id}:`);
      console.log(`  - Start Date: ${booking.startDate}`);
      console.log(`  - Pickup Time: ${booking.pickupTime}`);
      console.log(`  - Status: ${booking.status}`);

      // Parse the pickup time (format: "HH:MM" like "9:27")
      const [hours, minutes] = booking.pickupTime.split(":").map(Number);

      if (isNaN(hours) || isNaN(minutes)) {
        console.error(`[AutoCancellation] Invalid pickup time format for booking ${booking.id}: ${booking.pickupTime}`);
        return false;
      }

      // Get the start date and extract the date components
      const startDate = new Date(booking.startDate);

      // The key insight: we need to create the pickup datetime based on the calendar date
      // that the user intended, not by modifying the UTC timestamp

      // Convert start date to IST to get the correct calendar date
      const startDateIST = new Date(startDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

      // Create pickup datetime using the IST calendar date and pickup time
      const pickupDateTime = new Date(
        startDateIST.getFullYear(),
        startDateIST.getMonth(),
        startDateIST.getDate(),
        hours,
        minutes,
        0,
        0
      );

      console.log(`  - Start date converted to IST: ${startDateIST.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
      console.log(`  - Pickup datetime created: ${pickupDateTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
      console.log(`  - Current time: ${currentTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);

      // Check if current time has passed the pickup time
      const isOverdue = currentTime > pickupDateTime;

      console.log(`  - Is overdue: ${isOverdue}`);

      if (isOverdue) {
        const timeDiffMs = currentTime.getTime() - pickupDateTime.getTime();
        const timeDiffMinutes = Math.floor(timeDiffMs / (1000 * 60));
        console.log(`[AutoCancellation] Booking ${booking.id} is overdue by ${timeDiffMinutes} minutes`);
      } else {
        const timeDiffMs = pickupDateTime.getTime() - currentTime.getTime();
        const timeDiffMinutes = Math.floor(timeDiffMs / (1000 * 60));
        console.log(`[AutoCancellation] Booking ${booking.id} is scheduled in ${timeDiffMinutes} minutes`);
      }

      return isOverdue;
    } catch (error) {
      console.error(
        `[AutoCancellation] Error checking booking ${booking.id}:`,
        error
      );
      return false;
    }
  }

  /**
   * Cancel an overdue long distance booking (with refund logic)
   */
  private static async cancelOverdueLongDistanceBooking(
    booking: any
  ): Promise<void> {
    try {
      console.log(
        `[AutoCancellation] Cancelling overdue booking ${booking.id}`
      );

      // Update booking status to cancelled
      const cancelledBooking = await prisma.$transaction(async (tx) => {
        // Update the booking
        const updated = await tx.longDistanceBooking.update({
          where: { id: booking.id },
          data: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancelledBy: "SYSTEM",
            cancelReason:
              "No driver found within pickup time - automatically cancelled",
            metadata: {
              ...((booking.metadata as any) || {}),
              autoCancelledAt: new Date().toISOString(),
              autoCancelReason: "PICKUP_TIME_EXCEEDED_NO_DRIVER",
            },
          },
        });

        // If advance payment was made, process refund to user's wallet
        if (
          booking.advancePaymentStatus === "COMPLETED" &&
          booking.advanceAmount > 0
        ) {
          console.log(
            `[AutoCancellation] Processing refund for booking ${booking.id}, amount: ${booking.advanceAmount}`
          );

          // Add refund to user's wallet
          await tx.wallet.upsert({
            where: { userId: booking.userId },
            create: {
              userId: booking.userId,
              balance: booking.advanceAmount,
            },
            update: {
              balance: {
                increment: booking.advanceAmount,
              },
            },
          });

          // Create refund transaction record
          await tx.longDistanceTransaction.create({
            data: {
              bookingId: booking.id,
              amount: booking.advanceAmount,
              type: "REFUND",
              status: "COMPLETED",
              description: `Auto-refund for cancelled booking ${booking.id} - no driver found within pickup time`,
              senderId: null,
              receiverId: booking.userId,
            },
          });

          console.log(
            `[AutoCancellation] Refund processed for booking ${booking.id}`
          );
        }

        return updated;
      });

      // Emit cancellation notification to user
      if (booking.user?.id) {
        io.to(booking.user.id).emit("booking_cancelled", {
          bookingId: booking.id,
          reason: "No driver found within pickup time",
          cancelledBy: "SYSTEM",
          serviceType: booking.serviceType,
          refundAmount:
            booking.advancePaymentStatus === "COMPLETED"
              ? booking.advanceAmount
              : 0,
          message:
            "Your booking has been automatically cancelled as no driver was found within the pickup time. Any advance payment has been refunded to your wallet.",
        });
      }

      // Emit to all drivers that this booking is no longer available (cleanup)
      io.emit("booking_unavailable", {
        bookingId: booking.id,
        reason: "auto_cancelled_pickup_time_exceeded",
        serviceType: booking.serviceType,
      });

      console.log(
        `[AutoCancellation] Successfully cancelled booking ${booking.id} and notified user`
      );
    } catch (error) {
      console.error(
        `[AutoCancellation] Error cancelling booking ${booking.id}:`,
        error
      );
    }
  }

  /**
   * Cancel an overdue vendor booking (no refund needed)
   */
  private static async cancelOverdueVendorBooking(booking: any): Promise<void> {
    try {
      console.log(
        `[AutoCancellation] Cancelling overdue vendor booking ${booking.id}`
      );

      // Update vendor booking status to cancelled (no refund logic needed)
      const cancelledBooking = await prisma.vendorBooking.update({
        where: { id: booking.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelledBy: "SYSTEM",
          cancelReason:
            "No driver found within pickup time - automatically cancelled",
          metadata: {
            ...((booking.metadata as any) || {}),
            autoCancelledAt: new Date().toISOString(),
            autoCancelReason: "PICKUP_TIME_EXCEEDED_NO_DRIVER",
          },
        },
      });

      // Emit cancellation notification to vendor (no refund message needed)
      if (booking.vendor?.id) {
        io.to(booking.vendor.id).emit("booking_cancelled", {
          bookingId: booking.id,
          reason: "No driver found within pickup time",
          cancelledBy: "SYSTEM",
          serviceType: booking.serviceType,
          message:
            "Your vendor booking has been automatically cancelled as no driver was found within the pickup time.",
        });
      }

      // Emit to all drivers that this booking is no longer available (cleanup)
      io.emit("vendor_booking_unavailable", {
        bookingId: booking.id,
        reason: "auto_cancelled_pickup_time_exceeded",
        serviceType: booking.serviceType,
      });

      console.log(
        `[AutoCancellation] Successfully cancelled vendor booking ${booking.id} and notified vendor`
      );
    } catch (error) {
      console.error(
        `[AutoCancellation] Error cancelling vendor booking ${booking.id}:`,
        error
      );
    }
  }

  /**
   * Debug method to check a specific booking by ID
   */
  static async debugBooking(bookingId: string): Promise<void> {
    try {
      console.log(`[AutoCancellation] Debug check for booking ${bookingId}`);

      // Try to find as long distance booking first
      const longDistanceBooking = await prisma.longDistanceBooking.findUnique({
        where: { id: bookingId },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
        },
      });

      if (longDistanceBooking) {
        console.log(`[AutoCancellation] Found long distance booking:`);
        console.log(`  - ID: ${longDistanceBooking.id}`);
        console.log(`  - Status: ${longDistanceBooking.status}`);
        console.log(`  - Start Date: ${longDistanceBooking.startDate}`);
        console.log(`  - Pickup Time: ${longDistanceBooking.pickupTime}`);
        console.log(`  - Service Type: ${longDistanceBooking.serviceType}`);
        console.log(`  - Created At: ${longDistanceBooking.createdAt}`);

        const currentTime = new Date();
        const shouldCancel = this.shouldCancelBooking(longDistanceBooking, currentTime);
        console.log(`  - Should be cancelled: ${shouldCancel}`);

        if (shouldCancel) {
          console.log(`[AutoCancellation] This booking should be cancelled!`);
        }
        return;
      }

      // Try to find as vendor booking
      const vendorBooking = await prisma.vendorBooking.findUnique({
        where: { id: bookingId },
        include: {
          vendor: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
        },
      });

      if (vendorBooking) {
        console.log(`[AutoCancellation] Found vendor booking:`);
        console.log(`  - ID: ${vendorBooking.id}`);
        console.log(`  - Status: ${vendorBooking.status}`);
        console.log(`  - Start Date: ${vendorBooking.startDate}`);
        console.log(`  - Pickup Time: ${vendorBooking.pickupTime}`);
        console.log(`  - Service Type: ${vendorBooking.serviceType}`);
        console.log(`  - Created At: ${vendorBooking.createdAt}`);

        const currentTime = new Date();
        const shouldCancel = this.shouldCancelBooking(vendorBooking, currentTime);
        console.log(`  - Should be cancelled: ${shouldCancel}`);

        if (shouldCancel) {
          console.log(`[AutoCancellation] This vendor booking should be cancelled!`);
        }
        return;
      }

      console.log(`[AutoCancellation] No booking found with ID: ${bookingId}`);
    } catch (error) {
      console.error(`[AutoCancellation] Error debugging booking ${bookingId}:`, error);
    }
  }

  /**
   * Manual method to force check and cancel overdue bookings (for testing)
   */
  static async manualCheckAndCancel(): Promise<{
    longDistanceCancelled: number;
    vendorCancelled: number;
    total: number
  }> {
    try {
      console.log("[AutoCancellation] Manual check triggered");

      const currentTime = new Date();
      let longDistanceCancelled = 0;
      let vendorCancelled = 0;

      // Check long distance bookings
      const waitingLongDistance = await prisma.longDistanceBooking.findMany({
        where: {
          status: {
            in: ["PENDING", "ADVANCE_PAID"],
          },
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
        },
      });

      for (const booking of waitingLongDistance) {
        if (this.shouldCancelBooking(booking, currentTime)) {
          await this.cancelOverdueLongDistanceBooking(booking);
          longDistanceCancelled++;
        }
      }

      // Check vendor bookings
      const waitingVendor = await prisma.vendorBooking.findMany({
        where: {
          status: "PENDING",
        },
        include: {
          vendor: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
        },
      });

      for (const booking of waitingVendor) {
        if (this.shouldCancelBooking(booking, currentTime)) {
          await this.cancelOverdueVendorBooking(booking);
          vendorCancelled++;
        }
      }

      const total = longDistanceCancelled + vendorCancelled;
      console.log(`[AutoCancellation] Manual check completed: ${longDistanceCancelled} long distance, ${vendorCancelled} vendor, ${total} total cancelled`);

      return {
        longDistanceCancelled,
        vendorCancelled,
        total
      };
    } catch (error) {
      console.error("[AutoCancellation] Error in manual check:", error);
      throw error;
    }
  }
}
