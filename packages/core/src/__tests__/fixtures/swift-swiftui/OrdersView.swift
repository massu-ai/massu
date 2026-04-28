import SwiftUI
import LocalAuthentication

struct OrdersView: View {
    @StateObject var api: OrdersAPI = .shared
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

final class OrdersAPI: ObservableObject {
    static let shared = OrdersAPI()
    private init() {}
}
