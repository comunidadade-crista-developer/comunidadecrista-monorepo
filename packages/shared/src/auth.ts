import { z } from "zod";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MESSAGES,
  PASSWORD_MIN_LENGTH,
  containsUsername,
  isCommonPassword,
} from "./password-policy.js";

export const Username = z
  .string()
  .min(3, "nome de utilizador tem de ter pelo menos 3 caracteres")
  .max(30, "nome de utilizador tem no máximo 30 caracteres")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "apenas letras, números, ponto, underscore e hífen",
  );

// Palavra-passe NOVA (registo, recuperação): ver password-policy.ts.
export const NewPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, PASSWORD_MESSAGES.tooShort)
  .max(PASSWORD_MAX_LENGTH, PASSWORD_MESSAGES.tooLong)
  .refine((p) => !isCommonPassword(p), PASSWORD_MESSAGES.common);

// Login: não aplica a política nova, para as contas com palavras-passe antigas (6–20) entrarem.
// O máximo existe só para o Argon2 não receber entradas gigantes.
export const LoginPassword = z
  .string()
  .min(1, "indica a palavra-passe")
  .max(PASSWORD_MAX_LENGTH, PASSWORD_MESSAGES.tooLong);

// Confirmação: só tem de coincidir com a nova; a política aplica-se ao campo original.
const PasswordConfirmation = z
  .string()
  .min(1, "confirma a palavra-passe")
  .max(PASSWORD_MAX_LENGTH, PASSWORD_MESSAGES.tooLong);

export const SecurityAnswer = z.string().min(1).max(100);
export const NumberAnswer = z.string().regex(/^\d{1,3}$/, "número de 0 a 999");

export const UserPublic = z.object({
  id: z.uuid(),
  username: z.string(),
  role: z.enum(["user", "admin"]),
});

export const RegisterRequest = z
  .object({
    username: Username,
    password: NewPassword,
    passwordConfirmation: PasswordConfirmation,
    securityQ1: SecurityAnswer,
    securityQ2: NumberAnswer,
    securityQ3: SecurityAnswer,
  })
  .refine((d) => d.password === d.passwordConfirmation, {
    message: "as palavras-passe não coincidem",
    path: ["passwordConfirmation"],
  })
  .refine((d) => !containsUsername(d.password, d.username), {
    message: PASSWORD_MESSAGES.containsUsername,
    path: ["password"],
  });
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const RegisterResponse = z.object({
  user: UserPublic,
  accessToken: z.string(),
  refreshToken: z.string(),
  recoveryCode: z.string(),
  recoveryCodeWarning: z.string(),
});
export type RegisterResponse = z.infer<typeof RegisterResponse>;

export const LoginRequest = z.object({
  username: Username,
  password: LoginPassword,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  user: UserPublic,
  accessToken: z.string(),
  refreshToken: z.string(),
  // Alguém pediu recuperação por perguntas e o pedido foi cancelado por este login.
  pendingRecoveryCancelled: z.boolean().optional(),
  // Só no 1.º login depois de uma recuperação por perguntas ter produzido efeito.
  recoveryCode: z.string().optional(),
  recoveryCodeWarning: z.string().optional(),
  // A conta estava em apagamento e este login reactivou-a.
  accountRestored: z.boolean().optional(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const RefreshRequest = z.object({ refreshToken: z.string().min(1) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const RefreshResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type RefreshResponse = z.infer<typeof RefreshResponse>;

export const LogoutRequest = z.object({ refreshToken: z.string().min(1) });

export const MeResponse = z.object({
  user: UserPublic.extend({ createdAt: z.iso.datetime() }),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const RecoverVerifyRequest = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("code"),
    username: Username,
    code: z.string().min(1).max(30),
  }),
  z.object({
    mode: z.literal("questions"),
    username: Username,
    answer1: SecurityAnswer,
    answer2: NumberAnswer,
    answer3: SecurityAnswer,
  }),
]);
export type RecoverVerifyRequest = z.infer<typeof RecoverVerifyRequest>;

export const RecoverVerifyResponse = z.object({
  recoverySession: z.string(),
  expiresIn: z.number(),
});
export type RecoverVerifyResponse = z.infer<typeof RecoverVerifyResponse>;

export const RecoverResetRequest = z
  .object({
    recoverySession: z.string(),
    newPassword: NewPassword,
    newPasswordConfirmation: PasswordConfirmation,
  })
  .refine((d) => d.newPassword === d.newPasswordConfirmation, {
    message: "as palavras-passe não coincidem",
    path: ["newPasswordConfirmation"],
  });
export type RecoverResetRequest = z.infer<typeof RecoverResetRequest>;

export const RecoverResetResponse = z.object({
  // 'completed': palavra-passe mudada já (via código). 'pending': só produz efeito em effectiveAt
  // (via perguntas) e não é emitido código novo.
  status: z.enum(["completed", "pending"]),
  recoveryCode: z.string().optional(),
  recoveryCodeWarning: z.string().optional(),
  effectiveAt: z.iso.datetime().optional(),
});
export type RecoverResetResponse = z.infer<typeof RecoverResetResponse>;

export const DeletionPostsMode = z.enum(["anonymize", "delete"]);
export type DeletionPostsMode = z.infer<typeof DeletionPostsMode>;

// A palavra-passe confirma que é mesmo o dono (um access token roubado não chega).
export const DeleteAccountRequest = z.object({
  password: LoginPassword,
  postsMode: DeletionPostsMode,
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;

export const DeleteAccountResponse = z.object({
  status: z.literal("pending_deletion"),
  // Até esta data um login reactiva a conta; depois é apagada de vez.
  purgeAt: z.iso.datetime(),
});
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponse>;

// Formato único de erro da API: `error` é um código estável (snake_case) para o cliente
// reagir; `fields` só existe em erros de validação (campo → mensagem); `message` é opcional
// e nunca leva detalhes internos.
export const ErrorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
