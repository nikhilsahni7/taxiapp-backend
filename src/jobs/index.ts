import { startVendorBookingJobs } from "./vendorBookingJobs";

/**
 * Initialize all scheduled jobs
 */
export const startAllJobs = (): void => {
  // Start vendor booking jobs
  startVendorBookingJobs();

  console.log("All scheduled jobs started");
};
