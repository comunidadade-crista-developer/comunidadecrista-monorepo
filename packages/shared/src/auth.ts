import { z } from "zod";

export const Username = z
  .string()
  .min(3, "nome de utilizador tem de ter pelo menos 3 caracteres")
  .max(30, "nome de utilizador tem no máximo 30 caracteres")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "apenas letras, números, ponto, underscore e hífen",
  );

export const Password = z
  .string()
  .min(6, "palavra-passe tem de ter pelo menos 6 caracteres")
  .max(20, "palavra-passe tem no máximo 20 caracteres");

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
    password: Password,
    passwordConfirmation: Password,
    securityQ1: SecurityAnswer,
    securityQ2: NumberAnswer,
    securityQ3: SecurityAnswer,
  })
  .refine((d) => d.password === d.passwordConfirmation, {
    message: "as palavras-passe não coincidem",
    path: ["passwordConfirmation"],
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
  password: Password,
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
    newPassword: Password,
    newPasswordConfirmation: Password,
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

// Formato único de erro da API: `error` é um código estável (snake_case) para o cliente
// reagir; `fields` só existe em erros de validação (campo → mensagem); `message` é opcional
// e nunca leva detalhes internos.
export const ErrorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
