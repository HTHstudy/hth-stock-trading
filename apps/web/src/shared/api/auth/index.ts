import { getSession } from './endpoints/get-session';
import { loginOwner } from './endpoints/login-owner';
import { logoutOwner } from './endpoints/logout-owner';
export const AUTH_API = { session: getSession, login: loginOwner, logout: logoutOwner };
