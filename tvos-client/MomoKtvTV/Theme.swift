import SwiftUI

// MARK: - Exact Web Colors (from CSS :root)
enum WebColors {
    static let bg = Color(hex: 0x07071a)
    static let navy = Color(hex: 0x0d0d2b)
    static let ac = Color(hex: 0xc736f7)
    static let ac2 = Color(hex: 0x36d9f7)
    static let pink = Color(hex: 0xff4f9b)
    static let text = Color.white
    static let sub = Color.white.opacity(0.5)
    static let topbarBg = Color(red: 5/255, green: 5/255, blue: 20/255).opacity(0.88)
    static let topbarBorder = Color.white.opacity(0.07)
    static let nbBorder = Color.white.opacity(0.2)
    static let nbBg = Color.white.opacity(0.06)
    static let nbFocusBg = Color(hex: 0xc736f7).opacity(0.25)
    static let cardBg = Color.white.opacity(0.08)
    static let cardBorder = Color.white.opacity(0.1)
    static let panelBg = Color(red: 5/255, green: 5/255, blue: 20/255).opacity(0.95)
    static let nowIdleBg = Color(hex: 0x0d0d2b)
}

// MARK: - Gradients (exact from CSS)
extension LinearGradient {
    static let g1 = LinearGradient(colors: [Color(hex: 0xff4f9b), Color(hex: 0xff2255)], startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1))
    static let g2 = LinearGradient(colors: [Color(hex: 0xff8c42), Color(hex: 0xffd000)], startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1))
    static let g3 = LinearGradient(colors: [Color(hex: 0x8e44f7), Color(hex: 0xc736f7)], startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1))
    static let g4 = LinearGradient(colors: [Color(hex: 0x22c1c3), Color(hex: 0x1a7bff)], startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1))
    static let g5 = LinearGradient(colors: [Color(hex: 0xf73669), Color(hex: 0xff4f9b)], startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1))
    static let g6 = LinearGradient(colors: [Color(hex: 0xc736f7), Color(hex: 0x7b2cf7)], startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1))
    static let g7 = LinearGradient(colors: [Color(hex: 0x1a4bff), Color(hex: 0x36d9f7)], startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1))
}

// MARK: - Hex Color Extension
extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255.0,
                  green: Double((hex >> 8) & 0xFF) / 255.0,
                  blue: Double(hex & 0xFF) / 255.0)
    }
}

// MARK: - Theme
enum AppTheme: Int, CaseIterable {
    case theme1 = 1, theme2 = 2, theme3 = 3
    var name: String { ["紫墨焕彩", "暗夜霓虹", "动感韶音"][rawValue - 1] }

    // Theme 2 (Neon) colors
    static let neonBg = Color(hex: 0x0a0520)
    static let neonPanel = Color(red: 20/255, green: 10/255, blue: 50/255).opacity(0.42)
    static let neonCard = Color.white.opacity(0.08)
    static let neonPs = Color(red: 15/255, green: 15/255, blue: 40/255).opacity(0.5)

    // Theme 3 (Carousel) accent
    static let s3Accent = Color(hex: 0x00ffaa)
    static let s3Accent2 = Color(hex: 0x00aaff)
}

// MARK: - Nav Button (exact .nb style)
struct NavButton: View {
    let icon: String
    let title: String
    let badge: Int?
    var externalFocus: FocusState<Bool>.Binding? = nil
    let action: () -> Void
    @Environment(\.theme) var theme

    var body: some View {
        TVTightButton(action: action, externalFocus: externalFocus) { focused in
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 16))
                Text(title).font(.system(size: 16))
                if let badge = badge, badge > 0 {
                    Text("\(badge)")
                        .font(.system(size: 11))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(WebColors.ac)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(focused ? Color.white : WebColors.nbBg)
            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : Color.white.opacity(0.85))
            .cornerRadius(999)
        }
    }
}

// MARK: - MV Control Button (exact web style - dark bg, glass purple focus)
struct MVButton: View {
    let icon: String
    let title: String
    let action: () -> Void
    var isCenter: Bool = false

    var body: some View {
        TVTightButton(action: action) { focused in
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: isCenter ? 34 : 28, weight: .medium))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : Color.white.opacity(0.9))
                Text(title)
                    .font(.system(size: isCenter ? 18 : 17, weight: .semibold))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : Color.white.opacity(0.85))
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(focused ? Color.white : Color.white.opacity(0.08))
            )
            .padding(2)
            .background(focused ? Color.white.opacity(0.15) : Color.clear)
            .cornerRadius(16)
        }
    }
}

// MARK: - Mid Card (exact .mc style)
struct MidCard: View {
    let title: String
    let icon: String
    let gradient: LinearGradient
    let action: () -> Void

    var body: some View {
        TVTightButton(action: action) { focused in
            ZStack {
                Group {
                    if focused {
                        RoundedRectangle(cornerRadius: 14).fill(Color.white)
                    } else {
                        RoundedRectangle(cornerRadius: 14).fill(gradient)
                    }
                }
                .opacity(focused ? 1.0 : 0.85)
                VStack(spacing: 6) {
                    Image(systemName: icon).font(.system(size: 26))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                    Text(title).font(.system(size: 14, weight: .medium))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                }
            }
            .frame(height: 80)
        }
    }
}

// MARK: - Quick Mini Card (exact .mc-mini style)
struct QuickMiniCard: View {
    let title: String
    let icon: String
    let gradient: LinearGradient
    let action: () -> Void

    var body: some View {
        TVTightButton(action: action) { focused in
            HStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 22))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                Text(title).font(.system(size: 15, weight: .medium))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 14))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white.opacity(0.6))
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .background(Group { if focused { Color.white } else { gradient.opacity(0.8) } })
            .cornerRadius(12)
        }
    }
}

// MARK: - Theme Environment
struct ThemeKey: EnvironmentKey {
    static let defaultValue: AppTheme = .theme1
}
extension EnvironmentValues {
    var appTheme: AppTheme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
    var theme: ThemeColors {
        get { ThemeColors.theme1 }
        set { }
    }
}

// MARK: - ThemeColors Compatibility Layer
struct ThemeColors {
    let bg: Color
    let text: Color
    let subText: Color
    let accent: Color
    let accent2: Color
    let pink: Color
    let navy: Color
    let cardBg: Color
    let cardBorder: Color
    let topbarBg: Color
    let nowPlayingBg: Color
    let panelBg: Color
    let gradient1: LinearGradient
    let gradient2: LinearGradient
    let gradient3: LinearGradient
    let gradient4: LinearGradient

    static let theme1 = ThemeColors(
        bg: WebColors.bg, text: .white, subText: WebColors.sub,
        accent: WebColors.ac, accent2: WebColors.ac2,
        pink: WebColors.pink, navy: WebColors.navy,
        cardBg: WebColors.cardBg, cardBorder: WebColors.cardBorder,
        topbarBg: WebColors.topbarBg, nowPlayingBg: WebColors.navy,
        panelBg: WebColors.panelBg,
        gradient1: .g1, gradient2: .g2, gradient3: .g3, gradient4: .g4
    )
    static let theme2 = ThemeColors.theme1
    static let theme3 = ThemeColors.theme1
}
