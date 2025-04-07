import { CronJob } from "cron";
import { autoCancelPendingBookings } from "../controllers/vendorController";

/**
 * Automatically cancels pending vendor bookings that haven't been accepted
 * by any driver and where the pickup time has passed.
 *
 * Runs every hour at minute 0 (e.g., 1:00, 2:00, etc.)
 */
export const startVendorBookingJobs = (): void => {
  // Run every hour at minute 0
  const autoCancelJob = new CronJob("0 * * * *", async () => {
    try {
      console.log("[CRON] Running auto-cancel for pending vendor bookings");
      const result = await autoCancelPendingBookings();
      console.log(`[CRON] Auto-cancel completed: ${JSON.stringify(result)}`);
    } catch (error) {
      console.error("[CRON] Error in auto-cancel job:", error);
    }
  });

  // Start the job
  autoCancelJob.start();
  console.log("Vendor booking auto-cancel cron job scheduled");
};
