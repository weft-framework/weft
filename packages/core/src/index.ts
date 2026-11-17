import { AccessControl } from "./access.ts";
import type { AccessConfig, SettingsConfig } from "./config.ts";

export function defineAccess<
  const P extends string,
  const R extends string,
  const S extends string,
  const T extends SettingsConfig = {},
>(config: AccessConfig<P, R, S, T>): AccessControl<P, R, S, T> {
  return new AccessControl<P, R, S, T>(config);
}

export { AccessControl, explainText, Principal } from "./access.ts";
export type {
  AccessReport,
  ActingUser,
  CustomRoleInfo,
  ExplainedPermission,
  ExplainedRole,
  ExplainedSetting,
  InviteInfo,
  MemberInfo,
  Permission,
  PermissionDescription,
  RoleInfo,
  RoleName,
  ScopeInfo,
} from "./access.ts";
export { BUILTIN_PERMISSIONS } from "./config.ts";
export type {
  AccessConfig,
  BuiltinPermission,
  CustomConfig,
  CustomPermission,
  PermissionInfo,
  RoleConfig,
  ScopeTypeConfig,
  SettingConfig,
  SettingsConfig,
  SettingValue,
  SettingValues,
} from "./config.ts";
export { AccessError, isAccessError } from "./errors.ts";
export type { AccessErrorCode } from "./errors.ts";
export type { InviteRow, MemberRow, Models, PermissionRow, RoleRow, ScopeRow, SettingRow } from "./models.ts";
export { defineNotifications, Notifications } from "./notifications.ts";
export type {
  ChannelConfig,
  ChannelPreference,
  Delivery,
  DeliveryMode,
  DigestDelivery,
  DigestPeriod,
  NotificationModels,
  NotificationRow,
  NotificationsConfig,
  NotificationView,
  PreferenceRow,
  TypeConfig,
  TypePreference,
} from "./notifications.ts";
