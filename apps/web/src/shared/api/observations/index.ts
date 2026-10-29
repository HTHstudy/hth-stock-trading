import { getReports } from './endpoints/get-reports';
import { getReport } from './endpoints/get-report';
export const OBSERVATIONS_API = { list: getReports, get: getReport };
