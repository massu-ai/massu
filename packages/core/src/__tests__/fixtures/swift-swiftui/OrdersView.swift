import SwiftUI
import LocalAuthentication

struct OrdersView: View {
    @StateObject var api: HedgeAPI = .shared
    var body: some View {
        NavigationStack {
            List {
                Text("Orders")
            }
            .navigationTitle("Orders")
        }
    }
}

func authenticate() {
    let context = LAContext()
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "auth") { _, _ in }
}

final class HedgeAPI: ObservableObject {
    static let shared = HedgeAPI()
    private init() {}
}
