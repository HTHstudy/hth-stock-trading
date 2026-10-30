import { getReports } from './endpoints/get-reports';
import { getReport } from './endpoints/get-report';
import { getJobs } from './endpoints/get-jobs';
export const OBSERVATIONS_API = { list: getReports, get: getReport, jobs: getJobs };
