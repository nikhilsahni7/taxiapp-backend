import { CronJob } from "cron";
import { autoCancelPendingBookings } from "../controllers/vendorController";

/**
 * Automatically cancels pending vendor bookings that haven't been accepted
 * by any driver and where the pickup time has passed.
 *
 * Runs twice daily at 6:00 AM and 6:00 PM
 */
export const startVendorBookingJobs = (): void => {
  // Run at 6:00 AM and 6:00 PM
  const autoCancelJob = new CronJob("0 6,18 * * *", async () => {
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
  console.log(
    "Vendor booking auto-cancel cron job scheduled (twice daily at 6:00 AM and 6:00 PM)"
  );

  // Also run immediately on server start to clear any backlog
  console.log("Running initial auto-cancel check on server start");
  setTimeout(async () => {
    try {
      const result = await autoCancelPendingBookings();
      console.log(`Initial auto-cancel completed: ${JSON.stringify(result)}`);
    } catch (error) {
      console.error("Error in initial auto-cancel:", error);
    }
  }, 5000); // Wait 5 seconds after server start before running
};
