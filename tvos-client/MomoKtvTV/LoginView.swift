import SwiftUI

struct LoginView: View {
    let onLogin: (String) -> Void
    let onSkip: () -> Void
    @State private var username = ""
    @State private var password = ""
    @State private var remember = true
    @State private var error = ""
    @State private var loading = false
    @State private var hasUsers = true
    @FocusState private var focusedField: Field?

    enum Field { case username, password }

    var body: some View {
        ZStack {
            // Background (exact from login.html body::before)
            WebColors.bg.ignoresSafeArea()
            RadialGradient(colors: [WebColors.ac.opacity(0.16), .clear],
                           center: UnitPoint(x: 0.5, y: -0.1), startRadius: 0, endRadius: 500)
                .ignoresSafeArea()
            RadialGradient(colors: [WebColors.ac2.opacity(0.12), .clear],
                           center: UnitPoint(x: 0.9, y: 1.0), startRadius: 0, endRadius: 450)
                .ignoresSafeArea()

            VStack {
                Spacer()
                // Login card (exact .box)
                VStack(spacing: 0) {
                    // Title (exact h1)
                    Text("墨墨爱K歌")
                        .font(.system(size: 26, weight: .heavy))
                        .tracking(1)
                        .foregroundStyle(LinearGradient(colors: [WebColors.ac2, WebColors.ac, WebColors.pink],
                                                        startPoint: .leading, endPoint: .trailing))
                        .padding(.bottom, 6)

                    // Subtitle (exact .sub)
                    Text("请输入账号密码进入K歌主页面")
                        .font(.system(size: 13))
                        .tracking(1)
                        .foregroundColor(Color(hex: 0x8888aa))
                        .padding(.bottom, 26)

                    // Username input (exact input)
                    TextField("账号", text: $username)
                        .textContentType(.username)
                        .focused($focusedField, equals: .username)
                        .font(.system(size: 15))
                        .foregroundColor(Color(hex: 0xf4f4ff))
                        .padding(.horizontal, 14).padding(.vertical, 13)
                        .background(Color.white.opacity(0.06))
                        .cornerRadius(10)
                        .overlay(RoundedRectangle(cornerRadius: 10)
                            .stroke(focusedField == .username ? WebColors.ac : Color.white.opacity(0.1), lineWidth: 1))
                        .padding(.bottom, 14)
                        .onSubmit { focusedField = .password }

                    // Password input
                    SecureField("密码", text: $password)
                        .textContentType(.password)
                        .focused($focusedField, equals: .password)
                        .font(.system(size: 15))
                        .foregroundColor(Color(hex: 0xf4f4ff))
                        .padding(.horizontal, 14).padding(.vertical, 13)
                        .background(Color.white.opacity(0.06))
                        .cornerRadius(10)
                        .overlay(RoundedRectangle(cornerRadius: 10)
                            .stroke(focusedField == .password ? WebColors.ac : Color.white.opacity(0.1), lineWidth: 1))
                        .padding(.bottom, 14)
                        .onSubmit { doLogin() }

                    // Remember row (exact .remember-row)
                    Button(action: { remember.toggle() }) {
                        HStack(spacing: 8) {
                            Image(systemName: remember ? "checkmark.square.fill" : "square")
                                .font(.system(size: 16))
                                .foregroundColor(remember ? WebColors.ac : Color(hex: 0x8888aa))
                            Text("记住登录（30天内免登录）")
                                .font(.system(size: 13))
                                .foregroundColor(Color(hex: 0x8888aa))
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 2)
                    .padding(.bottom, 18)

                    // Error (exact #err)
                    if !error.isEmpty {
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundColor(WebColors.pink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.bottom, 12)
                    }

                    // Login button (exact .box button)
                    Button(action: doLogin) {
                        Text(loading ? "登录中..." : "进入")
                            .font(.system(size: 15, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                            .background(LinearGradient(colors: [WebColors.ac, WebColors.ac2],
                                                       startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1)))
                            .foregroundColor(WebColors.bg)
                            .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                    .disabled(loading || username.isEmpty || password.isEmpty)
                    .opacity(loading || username.isEmpty || password.isEmpty ? 0.5 : 1.0)

                    // Skip login
                    Button(action: onSkip) {
                        Text("跳过登录（仅浏览）")
                            .font(.system(size: 12))
                            .foregroundColor(Color(hex: 0x8888aa))
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 12)

                    // No user tip (exact #no-user-tip)
                    if !hasUsers {
                        VStack {
                            Text("还没有可用的登录账号，请让管理员先在「管理后台 → 用户管理」里创建一个账号。")
                                .font(.system(size: 12))
                                .foregroundColor(Color(hex: 0x8888aa))
                                .lineSpacing(3)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 16)
                        .padding(.bottom, 0)
                        .overlay(Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1), alignment: .top)
                        .padding(.top, 18)
                    }
                }
                .padding(.horizontal, 36)
                .padding(.vertical, 40)
                .frame(width: 360)
                .background(Color(hex: 0x10102a).opacity(0.78))
                .cornerRadius(20)
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.08), lineWidth: 1))
                Spacer()
            }
        }
        .onAppear { checkSession() }
    }

    private func checkSession() {
        hasUsers = true
    }

    private func doLogin() {
        loading = true
        error = ""
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            loading = false
            onLogin(username.isEmpty ? "TV用户" : username)
        }
    }
}
