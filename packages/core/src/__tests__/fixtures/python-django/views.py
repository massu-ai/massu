from django.contrib.auth.decorators import login_required, permission_required
from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import ListView


@login_required
def home(request):
    return None


@permission_required("app.view_widget")
def widget_list(request):
    return None


class WidgetListView(LoginRequiredMixin, ListView):
    pass
