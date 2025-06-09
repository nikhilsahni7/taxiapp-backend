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
      console.log('[AutoCancellation] Starting overdue booking check...');

      // Get current IST time
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
      const istNow = new Date(now.getTime() + istOffset);

      console.log(`[AutoCancellation] Current IST time: ${istNow.toISOString()}`);

      // Find all bookings that are still waiting for driver acceptance
      const waitingBookings = await prisma.longDistanceBooking.findMany({
        where: {
          status: {
            in: ["PENDING", "ADVANCE_PAID"] // Statuses where no driver has accepted yet
          },
          // Only check bookings where startDate is today or earlier
          startDate: {
            lte: istNow
          }
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              phone: true
            }
          }
        }
      });

      console.log(`[AutoCancellation] Found ${waitingBookings.length} bookings to check`);

      const bookingsToCancel = [];

      // Check each booking to see if pickup time has passed
      for (const booking of waitingBookings) {
        const shouldCancel = this.shouldCancelBooking(booking, istNow);
        if (shouldCancel) {
          bookingsToCancel.push(booking);
        }
      }

      console.log(`[AutoCancellation] Found ${bookingsToCancel.length} bookings to cancel`);

      // Cancel the overdue bookings
      for (const booking of bookingsToCancel) {
        await this.cancelOverdueBooking(booking);
      }

      if (bookingsToCancel.length > 0) {
        console.log(`[AutoCancellation] Successfully cancelled ${bookingsToCancel.length} overdue bookings`);
      }

    } catch (error) {
      console.error('[AutoCancellation] Error during overdue booking check:', error);
    }
  }

  /**
   * Determine if a booking should be cancelled based on pickup time
   */
  private static shouldCancelBooking(booking: any, istNow: Date): boolean {
    try {
      // Parse the pickup time (format: "HH:MM" like "13:26")
      const [hours, minutes] = booking.pickupTime.split(':').map(Number);

      // Create the pickup datetime in IST
      const pickupDate = new Date(booking.startDate);
      pickupDate.setHours(hours, minutes, 0, 0);

      // Add IST offset to pickup time for comparison
      const istOffset = 5.5 * 60 * 60 * 1000;
      const pickupTimeIST = new Date(pickupDate.getTime() + istOffset);

      // Check if current IST time has passed the pickup time
      const isOverdue = istNow > pickupTimeIST;

      if (isOverdue) {
        console.log(`[AutoCancellation] Booking ${booking.id} is overdue. Pickup: ${pickupTimeIST.toISOString()}, Now: ${istNow.toISOString()}`);
      }

      return isOverdue;

    } catch (error) {
      console.error(`[AutoCancellation] Error checking booking ${booking.id}:`, error);
      return false;
    }
  }

  /**
   * Cancel an overdue booking
   */
  private static async cancelOverdueBooking(booking: any): Promise<void> {
    try {
      console.log(`[AutoCancellation] Cancelling overdue booking ${booking.id}`);

      // Update booking status to cancelled
      const cancelledBooking = await prisma.$transaction(async (tx) => {
        // Update the booking
        const updated = await tx.longDistanceBooking.update({
          where: { id: booking.id },
          data: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancelledBy: "SYSTEM",
            cancelReason: "No driver found within pickup time - automatically cancelled",
            metadata: {
              ...((booking.metadata as any) || {}),
              autoCancelledAt: new Date().toISOString(),
              autoCancelReason: "PICKUP_TIME_EXCEEDED_NO_DRIVER"
            }
          }
        });

        // If advance payment was made, process refund to user's wallet
        if (booking.advancePaymentStatus === "COMPLETED" && booking.advanceAmount > 0) {
          console.log(`[AutoCancellation] Processing refund for booking ${booking.id}, amount: ${booking.advanceAmount}`);

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

          console.log(`[AutoCancellation] Refund processed for booking ${booking.id}`);
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
          refundAmount: booking.advancePaymentStatus === "COMPLETED" ? booking.advanceAmount : 0,
          message: "Your booking has been automatically cancelled as no driver was found within the pickup time. Any advance payment has been refunded to your wallet."
        });
      }

      // Emit to all drivers that this booking is no longer available (cleanup)
      io.emit("booking_unavailable", {
        bookingId: booking.id,
        reason: "auto_cancelled_pickup_time_exceeded",
        serviceType: booking.serviceType
      });

      console.log(`[AutoCancellation] Successfully cancelled booking ${booking.id} and notified user`);

    } catch (error) {
      console.error(`[AutoCancellation] Error cancelling booking ${booking.id}:`, error);
    }
  }
}
